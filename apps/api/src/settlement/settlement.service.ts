import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Settlement } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { SystemAccountService } from '../system-account/system-account.service.js';
import { SYSTEM_ACCOUNT_USER_ID } from '../system-account/system-account.constants.js';
import { MATCH_TRANSACTION_OPTIONS } from '../common/prisma-transaction.constants.js';
import type { AppConfiguration } from '../config/configuration.js';
import {
  computeRefundSettlement,
  computeWinSettlement,
  isBalanced,
  type SettlementComputation,
} from './settlement-math.js';

/**
 * The single settlement authority (Phase 5 spec section 23) — the only
 * service permitted to resolve a `MatchStake` into a terminal financial
 * outcome. Every caller (a match completing normally, an abandonment
 * forfeit, a stake-commit timeout, an admin-triggered recovery sweep)
 * goes through this one `settle()` method, which is safe to call
 * multiple times for the same match: the `@unique` constraint on
 * `Settlement.matchStakeId` is the actual exactly-once guarantee (a
 * second call returns the first call's result, never a second payout —
 * see docs/decisions/ADR-017-deterministic-settlement.md).
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly walletService: WalletService,
    private readonly systemAccountService: SystemAccountService,
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  /**
   * Resolves the match's financial outcome from its own authoritative,
   * already-decided state (`Match.status`/`winnerUserId`/`resultIsDraw`)
   * — never from a caller-supplied winner. Returns `null` for a match
   * with no `MatchStake` at all (ordinary free play — nothing to
   * settle). Idempotent: a retried call for an already-settled stake
   * returns the existing `Settlement`.
   */
  async settle(matchId: string): Promise<Settlement | null> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
    });
    if (!match) return null;

    const matchStake = await this.prisma.matchStake.findUnique({
      where: { matchId },
      include: { players: true },
    });
    if (!matchStake) return null;

    const existing = await this.prisma.settlement.findUnique({
      where: { matchStakeId: matchStake.id },
    });
    if (existing) return existing;

    const playerUserIds = matchStake.players.map((p) => p.userId);
    const heldPlayerUserIds = matchStake.players
      .filter((p) => p.heldAt !== null)
      .map((p) => p.userId);

    let outcome: 'WIN' | 'DRAW' | 'REFUND' | 'CANCELLED';
    let computation: SettlementComputation;

    if (
      match.status === 'CANCELLED' ||
      (match.status === 'ABANDONED' && !match.winnerUserId)
    ) {
      // CANCELLED covers both a pre-game cancellation (stake-commit
      // timeout) and the edge case of every player disconnecting at
      // once (ABANDONED with no winner) — in both cases nobody produced
      // a valid result, so whichever stakes were already held are
      // simply returned.
      outcome = 'CANCELLED';
      computation = computeRefundSettlement({
        stakeAmountMinor: matchStake.stakeAmountMinor,
        heldPlayerUserIds,
        role: 'REFUND_RECIPIENT',
      });
    } else if (match.status === 'COMPLETED' && match.resultIsDraw) {
      outcome = 'DRAW';
      computation = computeRefundSettlement({
        stakeAmountMinor: matchStake.stakeAmountMinor,
        heldPlayerUserIds: playerUserIds,
        role: 'DRAW_PARTICIPANT',
      });
    } else if (
      (match.status === 'COMPLETED' || match.status === 'ABANDONED') &&
      match.winnerUserId
    ) {
      outcome = 'WIN';
      computation = computeWinSettlement({
        stakeAmountMinor: matchStake.stakeAmountMinor,
        playerUserIds,
        winnerUserId: match.winnerUserId,
        feePercent: this.configService.get('stakes.platformFeePercent', {
          infer: true,
        }),
        systemAccountUserId: SYSTEM_ACCOUNT_USER_ID,
      });
    } else {
      throw new ConflictException(
        `Match ${matchId} is not in a settleable state (status=${match.status})`,
      );
    }

    if (!isBalanced(computation)) {
      // Defense in depth on top of settlement-math.spec.ts — this should
      // be unreachable. Never commit an unbalanced outcome.
      throw new Error(
        `Settlement computation for match ${matchId} is unbalanced — refusing to commit`,
      );
    }

    // Best-effort recovery signal (see MatchTimeoutService's recovery
    // sweep) — not itself the correctness mechanism, so its result is
    // never checked.
    await this.prisma.matchStake
      .updateMany({
        where: { id: matchStake.id, status: 'ACTIVE' },
        data: { status: 'SETTLING' },
      })
      .catch(() => {});

    try {
      return await this.prisma.$transaction(async (tx) => {
        const settlement = await tx.settlement.create({
          data: {
            matchStakeId: matchStake.id,
            outcome,
            status: 'PENDING',
            currency: matchStake.currency,
            poolAmountMinor: computation.poolAmountMinor,
            platformFeeAmountMinor: computation.platformFeeAmountMinor,
          },
        });

        // Lock every involved wallet in a fixed, deterministic order
        // (by userId) — settlement is the one place that can touch more
        // than one wallet in a single transaction, so without a fixed
        // order two settlements running concurrently (e.g. the same
        // player appearing in two different matches) could each hold
        // the lock the other needs. See LedgerService.lockWallet for
        // the single-wallet version of this same reasoning.
        const sortedMovements = [...computation.movements].sort((a, b) =>
          a.userId.localeCompare(b.userId),
        );

        for (const movement of sortedMovements) {
          const walletId =
            movement.userId === SYSTEM_ACCOUNT_USER_ID
              ? await this.systemAccountService.getWalletId(tx)
              : await this.walletService.getWalletIdForUser(
                  tx,
                  movement.userId,
                );

          const { entry } = await this.ledgerService.applyEntry(tx, walletId, {
            type: movement.ledgerType,
            availableDeltaMinor: movement.availableDeltaMinor,
            heldDeltaMinor: movement.heldDeltaMinor,
            relatedMatchStakeId: matchStake.id,
          });

          await tx.settlementEntry.create({
            data: {
              settlementId: settlement.id,
              userId: movement.userId,
              role: movement.role,
              availableDeltaMinor: movement.availableDeltaMinor,
              heldDeltaMinor: movement.heldDeltaMinor,
              ledgerEntryId: entry.id,
            },
          });
        }

        const completed = await tx.settlement.update({
          where: { id: settlement.id },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });

        await tx.matchStake.update({
          where: { id: matchStake.id },
          data: {
            status: outcome === 'CANCELLED' ? 'REFUNDED' : 'SETTLED',
          },
        });

        return completed;
      }, MATCH_TRANSACTION_OPTIONS);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Lost a race to another concurrent settle() call for the same
        // stake — the winner's result is the real outcome.
        const retried = await this.prisma.settlement.findUnique({
          where: { matchStakeId: matchStake.id },
        });
        if (retried) return retried;
      }
      this.logger.error(
        `Settlement failed for match ${matchId}: ${String(error)}`,
      );
      await this.prisma.matchStake
        .updateMany({
          where: { id: matchStake.id, status: 'SETTLING' },
          data: { status: 'FAILED', failureReason: String(error) },
        })
        .catch(() => {});
      throw error;
    }
  }
}
