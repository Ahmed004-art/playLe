import { UnprocessableEntityException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { MatchStakesService } from './match-stakes.service.js';

/**
 * `confirmStake` racing the stake-commit timeout (OUTSTANDING_WORK item 26).
 *
 * The `WAITING` check at the top of `confirmStake` runs outside the hold
 * transaction, so the timeout sweep can cancel the match - and refund it
 * without this player - between that check and the hold. These specs pin the
 * two places that must re-check the match inside a transaction: the hold
 * itself (under the match row lock) and the activation once everyone has
 * held. The database is replaced by fakes; the real interleaving against
 * Postgres is covered by `test/match-stakes.e2e-spec.ts` (CI only).
 */

const MATCH_ID = 'match-1';
const STAKE_ID = 'stake-1';
const user = { id: 'user-o' } as User;

interface Scenario {
  /** Match status the row lock inside the hold transaction reads. */
  statusUnderLock: string;
  /** Rows the conditional `WAITING -> ACTIVE` activation update reports. */
  activationCount?: number;
}

function build({ statusUnderLock, activationCount = 1 }: Scenario) {
  const players = (oHeld: boolean) => [
    { userId: 'user-x', heldAt: new Date() },
    { userId: user.id, heldAt: oHeld ? new Date() : null },
  ];
  const stake = (oHeld: boolean) => ({
    id: STAKE_ID,
    matchId: MATCH_ID,
    stakeAmountMinor: 750n,
    status: 'PENDING',
    players: players(oHeld),
  });

  const tx = {
    $queryRaw: vi.fn(() => Promise.resolve([{ status: statusUnderLock }])),
    matchStakePlayer: {
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
    },
    matchStake: { updateMany: vi.fn(() => Promise.resolve({ count: 1 })) },
    match: {
      updateMany: vi.fn(() => Promise.resolve({ count: activationCount })),
      findUniqueOrThrow: vi.fn(() =>
        Promise.resolve({
          id: MATCH_ID,
          status: 'ACTIVE',
          stateVersion: 0,
          state: {},
        }),
      ),
    },
    game: {
      findUnique: vi.fn(() => Promise.resolve({ turnTimeoutSeconds: null })),
    },
  };
  const prisma = {
    matchStake: {
      findUnique: vi.fn(() => Promise.resolve(stake(false))),
      findUniqueOrThrow: vi.fn(() => Promise.resolve(stake(true))),
    },
    match: {
      findUnique: vi.fn(() =>
        Promise.resolve({ status: 'WAITING', gameId: 'tic_tac_toe' }),
      ),
    },
    $transaction: vi.fn((fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const ledgerService = {
    lockWallet: vi.fn(() => Promise.resolve({})),
    applyEntry: vi.fn(() => Promise.resolve({})),
  };
  const walletService = {
    getWalletIdForUser: vi.fn(() => Promise.resolve('wallet-o')),
  };
  const emitter = { emitToMatch: vi.fn() };
  const eligibilityService = {
    assertCanStake: vi.fn(() => Promise.resolve()),
  };

  const service = new MatchStakesService(
    prisma as never,
    ledgerService as never,
    walletService as never,
    emitter as never,
    {} as never,
    eligibilityService as never,
  );
  return { service, tx, ledgerService, emitter };
}

describe('MatchStakesService.confirmStake vs. the stake-commit timeout', () => {
  it('rejects a hold when the match was cancelled after the WAITING pre-check', async () => {
    const { service, tx, ledgerService } = build({
      statusUnderLock: 'CANCELLED',
    });

    await expect(service.confirmStake(user, MATCH_ID)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );

    // Nothing was held: no heldAt, no STAKE_HOLD ledger entry.
    expect(tx.matchStakePlayer.updateMany).not.toHaveBeenCalled();
    expect(ledgerService.applyEntry).not.toHaveBeenCalled();
  });

  it('re-reads the match under a row lock inside the hold transaction', async () => {
    const { service, tx, ledgerService } = build({
      statusUnderLock: 'WAITING',
    });

    await service.confirmStake(user, MATCH_ID);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = tx.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join('?')).toMatch(
      /SELECT status FROM matches WHERE id = \? FOR UPDATE/,
    );
    expect(values).toEqual([MATCH_ID]);
    // The lock comes before the hold is written.
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.matchStakePlayer.updateMany.mock.invocationCallOrder[0],
    );
    expect(ledgerService.applyEntry).toHaveBeenCalledWith(tx, 'wallet-o', {
      type: 'STAKE_HOLD',
      availableDeltaMinor: -750n,
      heldDeltaMinor: 750n,
      relatedMatchStakeId: STAKE_ID,
    });
  });

  it('does not activate a match that stopped WAITING after the last hold', async () => {
    const { service, tx, emitter } = build({
      statusUnderLock: 'WAITING',
      activationCount: 0,
    });

    await service.confirmStake(user, MATCH_ID);

    expect(tx.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MATCH_ID, status: 'WAITING' },
      }),
    );
    // The stake is left for the cancellation's refund, not flipped ACTIVE.
    expect(tx.matchStake.updateMany).not.toHaveBeenCalled();
    expect(emitter.emitToMatch).not.toHaveBeenCalled();
  });

  it('activates match and stake together once every player has held', async () => {
    const { service, tx, emitter } = build({ statusUnderLock: 'WAITING' });

    await service.confirmStake(user, MATCH_ID);

    expect(tx.match.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MATCH_ID, status: 'WAITING' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
    expect(tx.matchStake.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: STAKE_ID, status: 'PENDING' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
    expect(emitter.emitToMatch).toHaveBeenCalledWith(
      MATCH_ID,
      'match:state',
      expect.objectContaining({ matchId: MATCH_ID, status: 'ACTIVE' }),
    );
  });
});
