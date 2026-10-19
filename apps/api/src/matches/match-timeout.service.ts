import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { GameRegistry } from '../games/game-registry.service.js';
import { RealtimeEmitterService } from '../realtime/realtime-emitter.service.js';
import { SettlementService } from '../settlement/settlement.service.js';
import { MATCH_TRANSACTION_OPTIONS } from '../common/prisma-transaction.constants.js';
import type { AppConfiguration } from '../config/configuration.js';

/**
 * Periodic sweep for every time-based state transition the platform
 * needs: an expired `WAITING` match (a staked match genuinely can reach
 * this — see `MatchesService.createMatch` — this is real, exercised
 * code, not a dormant path for a hypothetical future game), an expired
 * `PENDING` challenge, an `ACTIVE` match whose disconnected player's
 * grace period has elapsed, an `ACTIVE` match whose current turn-holder's
 * clock has elapsed (Phase 9 — ADR-024), and stale (expired, unanswered)
 * draw offers.
 *
 * A plain `setInterval` rather than `@nestjs/schedule` — that package
 * isn't installed, and a single periodic task doesn't justify adding it
 * (see CLAUDE.md, "avoid unnecessary dependencies"). Every sweep query is
 * either an atomic, status-conditioned `updateMany`, or (for turn
 * timeouts) the same row-locked transaction `MatchesService.submitCommand`
 * uses, so running this from multiple instances later is safe — each row
 * is only ever transitioned once regardless of how many instances race
 * to sweep it.
 */
@Injectable()
export class MatchTimeoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchTimeoutService.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gameRegistry: GameRegistry,
    private readonly emitter: RealtimeEmitterService,
    private readonly settlementService: SettlementService,
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.configService.get(
      'matches.timeoutSweepIntervalMs',
      {
        infer: true,
      },
    );
    this.timer = setInterval(() => {
      this.sweep().catch((error: unknown) => {
        this.logger.error(`Timeout sweep failed: ${String(error)}`);
      });
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    await this.expireWaitingMatches();
    await this.expireChallenges();
    await this.abandonDisconnectedMatches();
    await this.expireTimedOutTurns();
    await this.clearStaleDrawOffers();
    await this.recoverStuckSettlements();
  }

  /**
   * A financially-backed match that doesn't reach `HELD` in time (one or
   * both players never confirmed their stake) is cancelled; whichever
   * stake, if any, had already been held is refunded through the normal
   * `SettlementService` path (outcome `CANCELLED`) — nobody loses money
   * to a timeout. Free-play `WAITING` matches (no `MatchStake`) are
   * cancelled the same way; `settle()` is a no-op for them.
   */
  private async expireWaitingMatches(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.match.findMany({
      where: { status: 'WAITING', expiresAt: { lt: now } },
      select: { id: true },
    });
    if (expired.length === 0) return;

    let expiredCount = 0;
    for (const match of expired) {
      // Conditioned per-row on `status: 'WAITING'` (not a single bulk
      // `updateMany` over every id) so a match that activated (e.g. via
      // `confirmStake`) in the window between the read above and this
      // write is left alone rather than wrongly cancelled — and so the
      // settlement call below only ever fires for a row this sweep tick
      // actually transitioned.
      const { count } = await this.prisma.match.updateMany({
        where: { id: match.id, status: 'WAITING' },
        data: { status: 'CANCELLED', terminationReason: 'WAITING_TIMEOUT' },
      });
      if (count === 0) continue;
      expiredCount++;

      await this.settlementService.settle(match.id).catch((error: unknown) => {
        this.logger.error(
          `Settlement failed for cancelled match ${match.id}: ${String(error)}`,
        );
      });
    }
    if (expiredCount > 0) {
      this.logger.log(
        `Expired ${expiredCount} WAITING match(es) past their timeout`,
      );
    }
  }

  /**
   * Crash recovery (Phase 5 spec section 27): a match that already
   * reached a terminal status but whose `MatchStake` never made it to
   * `SETTLED`/`REFUNDED` (a process crash or transient failure between
   * the match completing and settlement finishing) is retried here.
   * `SettlementService.settle` is idempotent, so retrying a
   * genuinely-already-settled stake is always safe — this only ever
   * finishes work that was left incomplete, never redoes it.
   *
   * Two kinds of stake are picked up:
   * - an `ACTIVE`/`SETTLING`/`FAILED` stake on any terminal match; and
   * - a `PENDING` stake on a `CANCELLED` match that has no settlement yet.
   *   A match is cancelled by the stake-commit timeout while only *some*
   *   players had held, and such a stake never reached `ACTIVE`, so it
   *   stays `PENDING` — `settle()`'s own failure marking (`SETTLING →
   *   FAILED`) never applies to it. Without this branch, a crash or
   *   transient failure between `expireWaitingMatches` flipping the match
   *   to `CANCELLED` and its `settle()` call completing stranded the
   *   holders' funds with no automatic retry (OUTSTANDING_WORK item 26).
   *
   * The `PENDING` branch is deliberately limited to `CANCELLED` matches:
   * `settle()` refunds only the players whose `heldAt` is set there, so it
   * can never pay out an unheld stake. A `PENDING` stake on a
   * `COMPLETED`/`ABANDONED` match is not selected — `settle()` would treat
   * every player as having staked — and neither is one on a live
   * (`WAITING`/`READY`/`ACTIVE`) match. `settlement: null` stops an
   * already-settled stake from being re-selected every tick.
   */
  private async recoverStuckSettlements(): Promise<void> {
    const stuck = await this.prisma.matchStake.findMany({
      where: {
        OR: [
          {
            status: { in: ['ACTIVE', 'SETTLING', 'FAILED'] },
            match: { status: { in: ['COMPLETED', 'ABANDONED', 'CANCELLED'] } },
          },
          {
            status: 'PENDING',
            match: { status: 'CANCELLED' },
            settlement: null,
          },
        ],
      },
      select: { matchId: true },
    });
    if (stuck.length === 0) return;

    this.logger.log(`Recovering ${stuck.length} stuck settlement(s)`);
    for (const stake of stuck) {
      await this.settlementService
        .settle(stake.matchId)
        .catch((error: unknown) => {
          this.logger.error(
            `Settlement recovery failed for match ${stake.matchId}: ${String(error)}`,
          );
        });
    }
  }

  private async expireChallenges(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.challenge.findMany({
      where: { status: 'PENDING', expiresAt: { lt: now } },
      select: { id: true, challengerId: true, opponentId: true },
    });
    if (expired.length === 0) return;

    let expiredCount = 0;
    for (const challenge of expired) {
      // Conditioned per-row on `status: 'PENDING'` for the same reason as
      // `expireWaitingMatches` above — a challenge accepted/declined/
      // cancelled in the window between the read and this write must not
      // be overwritten, and the resolved-event emit below must only fire
      // for a challenge this sweep tick actually expired.
      const { count } = await this.prisma.challenge.updateMany({
        where: { id: challenge.id, status: 'PENDING' },
        data: { status: 'EXPIRED', respondedAt: now },
      });
      if (count === 0) continue;
      expiredCount++;

      this.emitter.emitToUser(challenge.challengerId, 'challenge:resolved', {
        challengeId: challenge.id,
        status: 'EXPIRED',
      });
      this.emitter.emitToUser(challenge.opponentId, 'challenge:resolved', {
        challengeId: challenge.id,
        status: 'EXPIRED',
      });
    }
    if (expiredCount > 0) {
      this.logger.log(`Expired ${expiredCount} challenge(s)`);
    }
  }

  private async abandonDisconnectedMatches(): Promise<void> {
    const graceMs = this.configService.get('matches.abandonGraceMs', {
      infer: true,
    });
    const cutoff = new Date(Date.now() - graceMs);

    const stale = await this.prisma.matchPlayer.findMany({
      where: {
        disconnectedAt: { lt: cutoff },
        match: { status: 'ACTIVE' },
      },
      include: { match: { include: { players: true } } },
    });

    for (const player of stale) {
      // Re-check status defensively: another sweep tick (or a command
      // that just completed the match) may have already resolved it.
      const stillConnectedOpponent = player.match.players.find(
        (p) => p.userId !== player.userId && p.disconnectedAt === null,
      );

      const { count } = await this.prisma.match.updateMany({
        where: { id: player.matchId, status: 'ACTIVE' },
        data: {
          status: 'ABANDONED',
          terminationReason: 'ABANDONED_DISCONNECT',
          completedAt: new Date(),
          winnerUserId: stillConnectedOpponent?.userId,
        },
      });

      if (count > 0) {
        this.emitter.emitToMatch(player.matchId, 'match:completed', {
          matchId: player.matchId,
          winnerUserId: stillConnectedOpponent?.userId ?? null,
          resultIsDraw: false,
          terminationReason: 'ABANDONED_DISCONNECT',
        });
        this.logger.log(
          `Match ${player.matchId} abandoned (player ${player.userId} disconnected past grace period)`,
        );
        // A forfeit still goes through the same deterministic settlement
        // pipeline as any other match result (Phase 5 spec section 21).
        await this.settlementService
          .settle(player.matchId)
          .catch((error: unknown) => {
            this.logger.error(
              `Settlement failed for abandoned match ${player.matchId}: ${String(error)}`,
            );
          });
      }
    }
  }

  /**
   * Finds every `ACTIVE` match whose `turnDeadlineAt` has elapsed and
   * processes each one (Phase 9 — ADR-024). The actual state transition
   * happens in `processTurnTimeout`, under the exact same
   * `SELECT ... FOR UPDATE` row lock `MatchesService.submitCommand` uses
   * — so a move racing a sweep tick for the same match is always safely
   * serialized, never double-processed, regardless of how many API
   * instances are running this sweep concurrently.
   */
  private async expireTimedOutTurns(): Promise<void> {
    const timedOut = await this.prisma.match.findMany({
      where: { status: 'ACTIVE', turnDeadlineAt: { lt: new Date() } },
      select: { id: true },
    });
    for (const { id } of timedOut) {
      await this.processTurnTimeout(id).catch((error: unknown) => {
        this.logger.error(
          `Turn-timeout processing failed for match ${id}: ${String(error)}`,
        );
      });
    }
  }

  /**
   * Forfeits the match to whoever did *not* hold the timed-out turn.
   * Re-checks `status`/`turnDeadlineAt` fresh under the row lock before
   * doing anything — idempotent and safe to call directly (tests call
   * it synchronously rather than waiting for the real interval, the
   * same convention `checkers.e2e-spec.ts` already uses for the other
   * sweeps).
   */
  async processTurnTimeout(matchId: string): Promise<void> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM matches WHERE id = ${matchId} FOR UPDATE`;

      const match = await tx.match.findUnique({ where: { id: matchId } });
      if (
        !match ||
        match.status !== 'ACTIVE' ||
        !match.turnDeadlineAt ||
        match.turnDeadlineAt > new Date()
      ) {
        // Raced with a move, a resign, a draw-accept, or another sweep
        // tick that already resolved this match — safe no-op.
        return null;
      }

      const gameModule = this.gameRegistry.get(match.gameId);
      const state = gameModule.deserializeState(match.state);
      const timedOutUserId = gameModule.currentTurnUserId(state);

      const opponent = timedOutUserId
        ? await tx.matchPlayer.findFirst({
            where: { matchId, userId: { not: timedOutUserId } },
          })
        : null;

      return tx.match.update({
        where: { id: matchId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          winnerUserId: opponent?.userId ?? null,
          resultIsDraw: false,
          terminationReason: 'TURN_TIMEOUT',
          turnDeadlineAt: null,
          pendingDrawOfferByUserId: null,
          pendingDrawOfferExpiresAt: null,
        },
      });
    }, MATCH_TRANSACTION_OPTIONS);

    if (outcome) {
      this.emitter.emitToMatch(matchId, 'match:completed', {
        matchId,
        winnerUserId: outcome.winnerUserId,
        resultIsDraw: false,
        terminationReason: 'TURN_TIMEOUT',
      });
      this.logger.log(`Match ${matchId} forfeited on turn timeout`);
      await this.settlementService.settle(matchId).catch((error: unknown) => {
        this.logger.error(
          `Settlement failed for turn-timed-out match ${matchId}: ${String(error)}`,
        );
      });
    }
  }

  /**
   * Clears a pending draw offer that was never accepted or rejected
   * before `pendingDrawOfferExpiresAt` elapsed. Lazy-expiry already
   * makes `MatchesService.submitCommand` treat a stale offer as absent
   * (see its `offerActive` check), so this is purely display hygiene —
   * without it, a finished-waiting offer would keep showing as pending
   * to the client until some other command happened to touch the match.
   * Unconditional on `status`: clearing it on a non-`ACTIVE` match is
   * harmless.
   */
  private async clearStaleDrawOffers(): Promise<void> {
    await this.prisma.match.updateMany({
      where: {
        pendingDrawOfferByUserId: { not: null },
        pendingDrawOfferExpiresAt: { lt: new Date() },
      },
      data: { pendingDrawOfferByUserId: null, pendingDrawOfferExpiresAt: null },
    });
  }
}
