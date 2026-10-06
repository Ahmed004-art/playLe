import type { LedgerEntryType, SettlementEntryRole } from '@prisma/client';

/**
 * Pure, dependency-free settlement arithmetic — no Prisma, no NestJS, no
 * I/O. Every money-moving decision a match settlement ever makes is
 * computed here and only here, so it can be exhaustively unit-tested
 * (including every boundary value) independently of a database. See
 * docs/decisions/ADR-017-deterministic-settlement.md.
 *
 * Rounding policy (Phase 5 spec section 49): `fee = floor(pool * pct /
 * 100)`, computed entirely in `BigInt` — `BigInt` division already
 * truncates toward zero, which is floor division for the non-negative
 * values a pool/percentage always are here.
 */

export interface SettlementPlayerMovement {
  userId: string;
  role: SettlementEntryRole;
  availableDeltaMinor: bigint;
  heldDeltaMinor: bigint;
  ledgerType: LedgerEntryType;
}

export interface SettlementComputation {
  poolAmountMinor: bigint;
  platformFeeAmountMinor: bigint;
  movements: SettlementPlayerMovement[];
}

export function computePlatformFee(
  poolAmountMinor: bigint,
  feePercent: number,
): bigint {
  if (feePercent < 0 || feePercent > 100) {
    throw new Error(`feePercent out of range: ${feePercent}`);
  }
  return (poolAmountMinor * BigInt(feePercent)) / 100n;
}

/**
 * A win (or a disconnect forfeit, which reuses this exact path — see
 * `SettlementService`): the winner receives the pool minus PlayLe's fee;
 * every other player's held stake is simply consumed (`STAKE_LOSS`); the
 * fee is credited to the platform/system account. Equal-stake is assumed
 * (enforced upstream by `MatchStake.stakeAmountMinor` being a single
 * shared value, never per-player).
 */
export function computeWinSettlement(params: {
  stakeAmountMinor: bigint;
  playerUserIds: string[];
  winnerUserId: string;
  feePercent: number;
  systemAccountUserId: string;
}): SettlementComputation {
  const {
    stakeAmountMinor,
    playerUserIds,
    winnerUserId,
    feePercent,
    systemAccountUserId,
  } = params;

  if (!playerUserIds.includes(winnerUserId)) {
    throw new Error('winnerUserId is not one of the settled players');
  }

  const poolAmountMinor = stakeAmountMinor * BigInt(playerUserIds.length);
  const platformFeeAmountMinor = computePlatformFee(
    poolAmountMinor,
    feePercent,
  );
  const payoutAmountMinor = poolAmountMinor - platformFeeAmountMinor;

  const movements: SettlementPlayerMovement[] = playerUserIds.map((userId) =>
    userId === winnerUserId
      ? {
          userId,
          role: 'WINNER' as const,
          availableDeltaMinor: payoutAmountMinor,
          heldDeltaMinor: -stakeAmountMinor,
          ledgerType: 'PRIZE' as const,
        }
      : {
          userId,
          role: 'LOSER' as const,
          availableDeltaMinor: 0n,
          heldDeltaMinor: -stakeAmountMinor,
          ledgerType: 'STAKE_LOSS' as const,
        },
  );

  if (platformFeeAmountMinor > 0n) {
    movements.push({
      userId: systemAccountUserId,
      role: 'PLATFORM_FEE',
      availableDeltaMinor: platformFeeAmountMinor,
      heldDeltaMinor: 0n,
      ledgerType: 'PLATFORM_FEE',
    });
  }

  return { poolAmountMinor, platformFeeAmountMinor, movements };
}

/**
 * A draw, or a pre-game cancellation/refund: every player who actually
 * held a stake gets exactly that stake back. No fee — PlayLe only takes
 * a cut of a prize pool that was actually won. `heldPlayerUserIds` is
 * deliberately only the players who reached `heldAt` — a cancellation
 * before the second player ever committed refunds just the first.
 */
export function computeRefundSettlement(params: {
  stakeAmountMinor: bigint;
  heldPlayerUserIds: string[];
  role: 'DRAW_PARTICIPANT' | 'REFUND_RECIPIENT';
}): SettlementComputation {
  const { stakeAmountMinor, heldPlayerUserIds, role } = params;

  const poolAmountMinor = stakeAmountMinor * BigInt(heldPlayerUserIds.length);

  const movements: SettlementPlayerMovement[] = heldPlayerUserIds.map(
    (userId) => ({
      userId,
      role,
      availableDeltaMinor: stakeAmountMinor,
      heldDeltaMinor: -stakeAmountMinor,
      ledgerType: 'STAKE_REFUND' as const,
    }),
  );

  return { poolAmountMinor, platformFeeAmountMinor: 0n, movements };
}

/**
 * Conservation invariant: every minor unit released from `held` lands
 * somewhere in `available` (the winner, the platform, or a refunded
 * player) — never more, never less. `SettlementService` asserts this
 * right before committing, as defense in depth on top of these unit
 * tests (see docs/architecture/SECURITY.md, "financial invariants
 * enforced twice").
 */
export function isBalanced(computation: SettlementComputation): boolean {
  const totalHeldReleased = computation.movements.reduce(
    (sum, m) => sum - m.heldDeltaMinor,
    0n,
  );
  const totalAvailableCredited = computation.movements.reduce(
    (sum, m) => sum + m.availableDeltaMinor,
    0n,
  );
  return totalHeldReleased === totalAvailableCredited;
}
