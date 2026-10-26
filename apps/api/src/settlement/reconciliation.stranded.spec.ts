import { describe, expect, it, vi } from 'vitest';
import { ReconciliationService } from './reconciliation.service.js';

/**
 * OUTSTANDING_WORK item 26 - stranded holds. Before PR #6, a stake confirmed
 * while the stake-commit timeout was cancelling its match could commit its
 * STAKE_HOLD after the cancellation had already refunded the other players and
 * marked the stake REFUNDED. That player's money stayed in held balance and no
 * existing check saw it: the stake is terminal (not an ORPHANED_HOLD), a
 * settlement exists (not a MISSING_SETTLEMENT), and the wallet still matches its
 * own ledger. The rule checked here: in a COMPLETED settlement every player who
 * held must have a settlement entry - whatever the outcome (win, draw or refund),
 * settlement releases every held stake. The database is replaced by a fake; the
 * real Postgres behaviour is in test/match-stakes.e2e-spec.ts (CI only).
 */

type Player = { userId: string; heldAt: Date | null };
type StakeRow = {
  id: string;
  matchId: string;
  status: string;
  players: Player[];
  settlement: {
    id: string;
    status: string;
    entries: { userId: string }[];
  } | null;
};

const held = (userId: string): Player => ({ userId, heldAt: new Date() });
const notHeld = (userId: string): Player => ({ userId, heldAt: null });

function build(stakes: StakeRow[]) {
  const prisma = {
    matchStake: {
      // Three checks call matchStake.findMany; only the stranded-hold check
      // asks for terminal (SETTLED/REFUNDED) stakes. The others get nothing so
      // the test isolates the new check.
      findMany: vi.fn((args: { where?: { status?: { in?: string[] } } }) => {
        const statuses = args.where?.status?.in ?? [];
        return Promise.resolve(statuses.includes('REFUNDED') ? stakes : []);
      }),
    },
    settlement: {
      groupBy: vi.fn(() => Promise.resolve([])),
      findMany: vi.fn(() => Promise.resolve([])),
    },
    wallet: { findMany: vi.fn(() => Promise.resolve([])) },
  };
  return { service: new ReconciliationService(prisma as never), prisma };
}

const refunded = (players: Player[], entryUsers: string[]): StakeRow => ({
  id: 'stake-1',
  matchId: 'match-1',
  status: 'REFUNDED',
  players,
  settlement: {
    id: 'settlement-1',
    status: 'COMPLETED',
    entries: entryUsers.map((userId) => ({ userId })),
  },
});

describe('ReconciliationService - stranded holds', () => {
  it('flags a player who held on a refunded stake but got no settlement entry (the pre-PR #6 late hold)', async () => {
    // x held and was refunded; o's late hold landed after the refund.
    const { service } = build([refunded([held('x'), held('o')], ['x'])]);

    const report = await service.runOnce();

    expect(report.anomalies).toEqual([
      expect.objectContaining({
        type: 'STRANDED_HOLD',
        matchId: 'match-1',
        matchStakeId: 'stake-1',
        settlementId: 'settlement-1',
        userId: 'o',
      }),
    ]);
  });

  it('reports nothing when every holder was released by the settlement', async () => {
    const { service } = build([refunded([held('x'), notHeld('o')], ['x'])]);

    expect((await service.runOnce()).anomalies).toEqual([]);
  });

  it('applies to a SETTLED (win/draw) stake too: every holder needs an entry', async () => {
    const { service } = build([
      {
        id: 'stake-2',
        matchId: 'match-2',
        status: 'SETTLED',
        players: [held('w'), held('l')],
        // The loser's release entry is missing.
        settlement: {
          id: 'settlement-2',
          status: 'COMPLETED',
          entries: [{ userId: 'w' }, { userId: 'system' }],
        },
      },
    ]);

    const anomalies = (await service.runOnce()).anomalies;
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      type: 'STRANDED_HOLD',
      userId: 'l',
      matchStakeId: 'stake-2',
    });
  });

  it('reports one anomaly per stranded player', async () => {
    const { service } = build([
      refunded([held('x'), held('o'), held('p')], ['x']),
    ]);

    const users = (await service.runOnce()).anomalies
      .map((a) => a.userId)
      .sort();
    expect(users).toEqual(['o', 'p']);
  });

  it('ignores a settlement that has not completed (another check owns that case)', async () => {
    const pending = refunded([held('x'), held('o')], []);
    pending.settlement = { id: 's-p', status: 'PENDING', entries: [] };
    const { service } = build([pending]);

    expect((await service.runOnce()).anomalies).toEqual([]);
  });

  it('only queries terminal stakes that have a settlement, and stays read-only', async () => {
    const { service, prisma } = build([]);

    await service.runOnce();

    expect(prisma.matchStake.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ['SETTLED', 'REFUNDED'] },
          settlement: { isNot: null },
        },
      }),
    );
    // No write methods exist on the fake; reaching here means none were needed.
  });
});
