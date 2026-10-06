import { describe, expect, it } from 'vitest';
import {
  computePlatformFee,
  computeRefundSettlement,
  computeWinSettlement,
  isBalanced,
} from './settlement-math.js';

const SYSTEM = 'system-platform-account';

describe('computePlatformFee', () => {
  it('matches the documented example (Le100 each, 10% fee)', () => {
    expect(computePlatformFee(20000n, 10)).toBe(2000n);
  });

  it('floors instead of rounding', () => {
    // pool=999, 10% => 99.9 -> floors to 99
    expect(computePlatformFee(999n, 10)).toBe(99n);
  });

  it('is zero when the pool is zero', () => {
    expect(computePlatformFee(0n, 10)).toBe(0n);
  });

  it('is zero when the fee percent is zero', () => {
    expect(computePlatformFee(100000n, 0)).toBe(0n);
  });

  it('takes the whole pool at 100%', () => {
    expect(computePlatformFee(100n, 100)).toBe(100n);
  });

  it('handles a pool of 1 minor unit at a non-trivial percent (floors to 0)', () => {
    expect(computePlatformFee(1n, 10)).toBe(0n);
  });

  it('rejects an out-of-range percent', () => {
    expect(() => computePlatformFee(100n, 101)).toThrow();
    expect(() => computePlatformFee(100n, -1)).toThrow();
  });
});

describe('computeWinSettlement', () => {
  it('matches the documented example exactly (Le10 each, 10% fee)', () => {
    const result = computeWinSettlement({
      stakeAmountMinor: 1000n,
      playerUserIds: ['a', 'b'],
      winnerUserId: 'a',
      feePercent: 10,
      systemAccountUserId: SYSTEM,
    });

    expect(result.poolAmountMinor).toBe(2000n);
    expect(result.platformFeeAmountMinor).toBe(200n);

    const winner = result.movements.find((m) => m.userId === 'a')!;
    expect(winner.role).toBe('WINNER');
    expect(winner.availableDeltaMinor).toBe(1800n);
    expect(winner.heldDeltaMinor).toBe(-1000n);
    expect(winner.ledgerType).toBe('PRIZE');

    const loser = result.movements.find((m) => m.userId === 'b')!;
    expect(loser.role).toBe('LOSER');
    expect(loser.availableDeltaMinor).toBe(0n);
    expect(loser.heldDeltaMinor).toBe(-1000n);
    expect(loser.ledgerType).toBe('STAKE_LOSS');

    const platform = result.movements.find((m) => m.userId === SYSTEM)!;
    expect(platform.role).toBe('PLATFORM_FEE');
    expect(platform.availableDeltaMinor).toBe(200n);
    expect(platform.heldDeltaMinor).toBe(0n);
    expect(platform.ledgerType).toBe('PLATFORM_FEE');

    expect(isBalanced(result)).toBe(true);
  });

  it('omits a platform-fee movement entirely when the fee rounds to zero', () => {
    const result = computeWinSettlement({
      stakeAmountMinor: 1n,
      playerUserIds: ['a', 'b'],
      winnerUserId: 'a',
      feePercent: 10,
      systemAccountUserId: SYSTEM,
    });

    expect(result.platformFeeAmountMinor).toBe(0n);
    expect(result.movements.find((m) => m.userId === SYSTEM)).toBeUndefined();
    expect(isBalanced(result)).toBe(true);
  });

  it('is balanced at a large stake value', () => {
    const result = computeWinSettlement({
      stakeAmountMinor: 1_000_000_000n,
      playerUserIds: ['a', 'b'],
      winnerUserId: 'b',
      feePercent: 10,
      systemAccountUserId: SYSTEM,
    });

    expect(isBalanced(result)).toBe(true);
    expect(result.movements.find((m) => m.userId === 'b')!.role).toBe('WINNER');
  });

  it('is balanced at 0% platform fee', () => {
    const result = computeWinSettlement({
      stakeAmountMinor: 1000n,
      playerUserIds: ['a', 'b'],
      winnerUserId: 'a',
      feePercent: 0,
      systemAccountUserId: SYSTEM,
    });

    expect(result.platformFeeAmountMinor).toBe(0n);
    expect(
      result.movements.find((m) => m.userId === 'a')!.availableDeltaMinor,
    ).toBe(2000n);
    expect(isBalanced(result)).toBe(true);
  });

  it('rejects a winnerUserId that is not one of the players', () => {
    expect(() =>
      computeWinSettlement({
        stakeAmountMinor: 1000n,
        playerUserIds: ['a', 'b'],
        winnerUserId: 'c',
        feePercent: 10,
        systemAccountUserId: SYSTEM,
      }),
    ).toThrow();
  });
});

describe('computeRefundSettlement', () => {
  it('refunds every held player their exact stake, with no fee', () => {
    const result = computeRefundSettlement({
      stakeAmountMinor: 1000n,
      heldPlayerUserIds: ['a', 'b'],
      role: 'DRAW_PARTICIPANT',
    });

    expect(result.poolAmountMinor).toBe(2000n);
    expect(result.platformFeeAmountMinor).toBe(0n);
    for (const movement of result.movements) {
      expect(movement.availableDeltaMinor).toBe(1000n);
      expect(movement.heldDeltaMinor).toBe(-1000n);
      expect(movement.role).toBe('DRAW_PARTICIPANT');
      expect(movement.ledgerType).toBe('STAKE_REFUND');
    }
    expect(isBalanced(result)).toBe(true);
  });

  it('refunds only the single player who actually held, for a partial cancellation', () => {
    const result = computeRefundSettlement({
      stakeAmountMinor: 1000n,
      heldPlayerUserIds: ['a'],
      role: 'REFUND_RECIPIENT',
    });

    expect(result.movements).toHaveLength(1);
    expect(result.movements[0].userId).toBe('a');
    expect(result.movements[0].availableDeltaMinor).toBe(1000n);
    expect(isBalanced(result)).toBe(true);
  });

  it('is a no-op (balanced, empty) when nobody had held anything', () => {
    const result = computeRefundSettlement({
      stakeAmountMinor: 1000n,
      heldPlayerUserIds: [],
      role: 'REFUND_RECIPIENT',
    });

    expect(result.movements).toHaveLength(0);
    expect(result.poolAmountMinor).toBe(0n);
    expect(isBalanced(result)).toBe(true);
  });
});

describe('isBalanced', () => {
  it('detects an unbalanced computation', () => {
    expect(
      isBalanced({
        poolAmountMinor: 100n,
        platformFeeAmountMinor: 0n,
        movements: [
          {
            userId: 'a',
            role: 'WINNER',
            availableDeltaMinor: 50n,
            heldDeltaMinor: -100n,
            ledgerType: 'PRIZE',
          },
        ],
      }),
    ).toBe(false);
  });
});
