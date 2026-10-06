import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeEmitterService } from '../realtime/realtime-emitter.service.js';
import { SettlementService } from '../settlement/settlement.service.js';
import type { AppConfiguration } from '../config/configuration.js';

/**
 * Periodic sweep for every time-based state transition the platform
 * needs: an expired `WAITING` match (currently unreachable in practice —
 * Phase 4's only game is 2-player and starts `ACTIVE` immediately — but
 * real, tested code for when a future game needs a real waiting room), an
 * expired `PENDING` challenge, and an `ACTIVE` match whose disconnected
 * player's grace period has elapsed.
 *
 * A plain `setInterval` rather than `@nestjs/schedule` — that package
 * isn't installed, and a single periodic task doesn't justify adding it
 * (see CLAUDE.md, "avoid unnecessary dependencies"). Every sweep query is
 * an atomic, status-conditioned `updateMany`, so running this from
 * multiple instances later is safe — each row is only ever transitioned
 * once regardless of how many instances race to sweep it.
 */
@Injectable()
export class MatchTimeoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchTimeoutService.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly prisma: PrismaService,
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

    await this.prisma.match.updateMany({
      where: { id: { in: expired.map((m) => m.id) } },
      data: { status: 'CANCELLED', terminationReason: 'WAITING_TIMEOUT' },
    });
    this.logger.log(
      `Expired ${expired.length} WAITING match(es) past their timeout`,
    );

    for (const match of expired) {
      await this.settlementService.settle(match.id).catch((error: unknown) => {
        this.logger.error(
          `Settlement failed for cancelled match ${match.id}: ${String(error)}`,
        );
      });
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
   */
  private async recoverStuckSettlements(): Promise<void> {
    const stuck = await this.prisma.matchStake.findMany({
      where: {
        status: { in: ['ACTIVE', 'SETTLING', 'FAILED'] },
        match: { status: { in: ['COMPLETED', 'ABANDONED', 'CANCELLED'] } },
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

    await this.prisma.challenge.updateMany({
      where: { id: { in: expired.map((c) => c.id) } },
      data: { status: 'EXPIRED', respondedAt: now },
    });

    for (const challenge of expired) {
      this.emitter.emitToUser(challenge.challengerId, 'challenge:resolved', {
        challengeId: challenge.id,
        status: 'EXPIRED',
      });
      this.emitter.emitToUser(challenge.opponentId, 'challenge:resolved', {
        challengeId: challenge.id,
        status: 'EXPIRED',
      });
    }
    this.logger.log(`Expired ${expired.length} challenge(s)`);
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
          reason: 'ABANDONED_DISCONNECT',
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
}
