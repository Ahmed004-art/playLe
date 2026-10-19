import { describe, expect, it, vi } from 'vitest';
import { MatchTimeoutService } from './match-timeout.service.js';

/**
 * Which stakes does the crash-recovery sweep pick up? (OUTSTANDING_WORK
 * item 26.) `recoverStuckSettlements` is exercised for real; only the
 * database is replaced by a tiny in-memory evaluator for the exact `where`
 * shape the service uses (`in`, equality, `null`, nested relations, `OR`).
 * It throws on any operator it does not understand, so a future change to
 * the query cannot silently be mis-evaluated by this fake.
 *
 * The end-to-end behaviour against real Postgres is covered by the e2e test
 * in `test/match-stakes.e2e-spec.ts` (CI only); this spec pins the
 * *eligibility rules* — including every case that must NOT be settled.
 */

type Where = Record<string, unknown>;

const UNSUPPORTED = [
  'not',
  'notIn',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'AND',
  'NOT',
];

function matches(where: Where, row: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (UNSUPPORTED.includes(key)) {
      throw new Error(`fake prisma: unsupported where operator "${key}"`);
    }
    if (key === 'OR') {
      return (cond as Where[]).some((branch) => matches(branch, row));
    }
    const value = row[key];
    if (cond === null) return value === null;
    if (typeof cond === 'object') {
      const c = cond as Where;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      return (
        value !== null &&
        typeof value === 'object' &&
        matches(c, value as Where)
      );
    }
    return value === cond;
  });
}

interface StakeRow {
  matchId: string;
  stakeStatus: string;
  matchStatus: string;
  settled?: boolean;
}

function build(rows: StakeRow[], settle = vi.fn().mockResolvedValue(null)) {
  const prisma = {
    matchStake: {
      findMany: vi.fn((args: { where: Where }) =>
        Promise.resolve(
          rows
            .filter((r) =>
              matches(args.where, {
                status: r.stakeStatus,
                match: { status: r.matchStatus },
                settlement: r.settled ? { id: 'settlement-1' } : null,
              }),
            )
            .map((r) => ({ matchId: r.matchId })),
        ),
      ),
    },
  };
  const service = new MatchTimeoutService(
    prisma as never,
    {} as never,
    {} as never,
    { settle } as never,
    { get: vi.fn().mockReturnValue(1000) } as never,
  );
  const recover = () => service['recoverStuckSettlements']();
  return { recover, settle };
}

function settledMatchIds(settle: ReturnType<typeof vi.fn>): string[] {
  return settle.mock.calls.map((call) => call[0] as string).sort();
}

describe('MatchTimeoutService.recoverStuckSettlements — eligibility', () => {
  it('retries a one-sided PENDING stake on a CANCELLED match (the gap)', async () => {
    const { recover, settle } = build([
      { matchId: 'm-gap', stakeStatus: 'PENDING', matchStatus: 'CANCELLED' },
    ]);
    await recover();
    expect(settledMatchIds(settle)).toEqual(['m-gap']);
  });

  it('keeps retrying every previously-covered stuck state', async () => {
    const { recover, settle } = build([
      { matchId: 'm1', stakeStatus: 'ACTIVE', matchStatus: 'COMPLETED' },
      { matchId: 'm2', stakeStatus: 'SETTLING', matchStatus: 'ABANDONED' },
      { matchId: 'm3', stakeStatus: 'FAILED', matchStatus: 'CANCELLED' },
      { matchId: 'm4', stakeStatus: 'ACTIVE', matchStatus: 'CANCELLED' },
    ]);
    await recover();
    expect(settledMatchIds(settle)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('never settles a PENDING stake unless its match is CANCELLED', async () => {
    // A PENDING stake means not every player held. Only a cancelled match
    // may legitimately end that way (settle() refunds just the holders). A
    // PENDING stake on any other match must never be auto-settled: for a
    // COMPLETED/ABANDONED match settle() would pay a win from stakes that
    // were never all held.
    const { recover, settle } = build([
      { matchId: 'waiting', stakeStatus: 'PENDING', matchStatus: 'WAITING' },
      { matchId: 'ready', stakeStatus: 'PENDING', matchStatus: 'READY' },
      { matchId: 'active', stakeStatus: 'PENDING', matchStatus: 'ACTIVE' },
      { matchId: 'done', stakeStatus: 'PENDING', matchStatus: 'COMPLETED' },
      { matchId: 'gone', stakeStatus: 'PENDING', matchStatus: 'ABANDONED' },
    ]);
    await recover();
    expect(settle).not.toHaveBeenCalled();
  });

  it('leaves already-settled stakes alone', async () => {
    const { recover, settle } = build([
      { matchId: 's1', stakeStatus: 'SETTLED', matchStatus: 'COMPLETED' },
      { matchId: 's2', stakeStatus: 'REFUNDED', matchStatus: 'CANCELLED' },
    ]);
    await recover();
    expect(settle).not.toHaveBeenCalled();
  });

  it('does not re-pick a PENDING/CANCELLED stake that already has a settlement', async () => {
    // Not reachable today (settlement and the stake's REFUNDED status commit
    // together), but if it ever were, picking it every tick would churn.
    const { recover, settle } = build([
      {
        matchId: 'has-settlement',
        stakeStatus: 'PENDING',
        matchStatus: 'CANCELLED',
        settled: true,
      },
    ]);
    await recover();
    expect(settle).not.toHaveBeenCalled();
  });

  it('settles only the eligible stakes out of a mixed set', async () => {
    const { recover, settle } = build([
      { matchId: 'gap', stakeStatus: 'PENDING', matchStatus: 'CANCELLED' },
      { matchId: 'active', stakeStatus: 'ACTIVE', matchStatus: 'COMPLETED' },
      { matchId: 'waiting', stakeStatus: 'PENDING', matchStatus: 'WAITING' },
      { matchId: 'done', stakeStatus: 'PENDING', matchStatus: 'COMPLETED' },
      {
        matchId: 'refunded',
        stakeStatus: 'REFUNDED',
        matchStatus: 'CANCELLED',
      },
    ]);
    await recover();
    expect(settledMatchIds(settle)).toEqual(['active', 'gap']);
  });

  it('keeps going when one retry fails, and does nothing when nothing is stuck', async () => {
    const failing = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(null);
    const { recover } = build(
      [
        { matchId: 'first', stakeStatus: 'PENDING', matchStatus: 'CANCELLED' },
        { matchId: 'second', stakeStatus: 'ACTIVE', matchStatus: 'COMPLETED' },
      ],
      failing,
    );
    await recover();
    expect(settledMatchIds(failing)).toEqual(['first', 'second']);

    const idle = build([]);
    await idle.recover();
    expect(idle.settle).not.toHaveBeenCalled();
  });
});
