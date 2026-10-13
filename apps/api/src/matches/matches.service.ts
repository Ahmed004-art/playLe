import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  type Game,
  type Match,
  type MatchCommand,
  type MatchPlayer,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { GameRegistry } from '../games/game-registry.service.js';
import { RealtimeEmitterService } from '../realtime/realtime-emitter.service.js';
import { SettlementService } from '../settlement/settlement.service.js';
import { MATCH_TRANSACTION_OPTIONS } from '../common/prisma-transaction.constants.js';
import type { CursorPage } from '../common/dto/pagination.dto.js';
import type { AppConfiguration } from '../config/configuration.js';

export type MatchWithPlayers = Match & { players: MatchPlayer[] };

/** Every command type the generic pipeline recognizes (Phase 9 — ADR-024). */
export const MATCH_COMMAND_TYPES = [
  'MOVE',
  'RESIGN',
  'DRAW_OFFER',
  'DRAW_ACCEPT',
  'DRAW_REJECT',
] as const;
export type MatchCommandType = (typeof MATCH_COMMAND_TYPES)[number];

/** Match statuses that mean "this user cannot start or join another match yet". */
const CONFLICTING_MATCH_STATUSES = ['WAITING', 'READY', 'ACTIVE'] as const;

/** A stake request already validated by the caller (see MatchStakesService). */
export interface StakeSpec {
  amountMinor: bigint;
  currency: string;
}

/**
 * Prisma client or interactive-transaction client — accepted so a caller
 * can create a match atomically with its own state change (e.g.
 * `ChallengesService.accept`).
 */
export type PrismaClientOrTx = Pick<PrismaService, 'match' | 'matchStake'>;

@Injectable()
export class MatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gameRegistry: GameRegistry,
    private readonly emitter: RealtimeEmitterService,
    private readonly settlementService: SettlementService,
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  /**
   * The only place a `Match` is created. Both players are already known
   * (matchmaking just formed a pair, or a challenge was just accepted).
   * Free play (`stake` omitted) starts `ACTIVE` immediately — there is
   * no real waiting-room window for a 2-player game (see
   * docs/decisions/ADR-015-game-module-architecture.md). A
   * financially-backed match (`stake` given) instead starts `WAITING`,
   * with a matching `MatchStake` (`PENDING`) created atomically in the
   * same call, and only becomes `ACTIVE` once every player has confirmed
   * their stake (see `MatchStakesService.confirmStake` and
   * docs/decisions/ADR-018-financial-state-machines.md for how the two
   * state machines coordinate). Accepts an optional transaction client
   * so a caller (e.g. `ChallengesService.accept`) can create the match
   * atomically with its own state change; defaults to the plain
   * `PrismaService`.
   */
  async createMatch(
    game: Game,
    playerUserIds: string[],
    tx: PrismaClientOrTx = this.prisma,
    stake?: StakeSpec,
  ): Promise<MatchWithPlayers> {
    const module = this.gameRegistry.get(game.id);
    const initialState = module.createInitialState(playerUserIds);
    const now = new Date();

    const turnDeadlineAt = game.turnTimeoutSeconds
      ? new Date(now.getTime() + game.turnTimeoutSeconds * 1000)
      : null;

    if (!stake) {
      return tx.match.create({
        data: {
          gameId: game.id,
          gameVersion: game.version,
          status: 'ACTIVE',
          state: module.serializeState(initialState) as Prisma.InputJsonValue,
          readyAt: now,
          startedAt: now,
          turnDeadlineAt,
          players: {
            create: playerUserIds.map((userId, seat) => ({ userId, seat })),
          },
        },
        include: { players: true },
      });
    }

    const commitTimeoutMs = this.configService.get(
      'stakes.stakeCommitTimeoutMs',
      { infer: true },
    );

    const match = await tx.match.create({
      data: {
        gameId: game.id,
        gameVersion: game.version,
        status: 'WAITING',
        state: module.serializeState(initialState) as Prisma.InputJsonValue,
        expiresAt: new Date(now.getTime() + commitTimeoutMs),
        players: {
          create: playerUserIds.map((userId, seat) => ({ userId, seat })),
        },
      },
      include: { players: true },
    });

    await tx.matchStake.create({
      data: {
        matchId: match.id,
        currency: stake.currency,
        stakeAmountMinor: stake.amountMinor,
        players: {
          create: playerUserIds.map((userId) => ({ userId })),
        },
      },
    });

    return match;
  }

  /**
   * Like `createMatch`, but additionally guarantees none of
   * `playerUserIds` already holds a `WAITING`/`READY`/`ACTIVE` match —
   * closing the race between matchmaking and challenge-accept (or two
   * concurrent challenge-accepts) sharing a user (Phase 9 — ADR-024,
   * "Duplicate-match prevention"). Requires a real transaction client
   * (never defaults to `this.prisma`), since the lock, the conflict
   * check, and the creation must all happen atomically together.
   *
   * There is no single row to lock for "is this user about to be in a
   * match" (that fact doesn't exist as a row until the match is
   * created), so this acquires a Postgres advisory transaction lock per
   * user instead — `pg_advisory_xact_lock` is held until the
   * transaction commits or rolls back, and is released automatically
   * either way. Two concurrent calls that share a user always block on
   * the same lock key, so the second one's conflict check is guaranteed
   * to see the first's already-created match. Users are locked in
   * sorted order — the same fixed-ordering discipline
   * `SettlementService.settle` already uses for multi-wallet locking —
   * so two calls sharing *two* users (e.g. the same pair matched twice)
   * can never acquire the locks in reverse order.
   */
  async createMatchGuarded(
    game: Game,
    playerUserIds: string[],
    tx: Prisma.TransactionClient,
    stake?: StakeSpec,
  ): Promise<MatchWithPlayers> {
    const sortedUserIds = [...playerUserIds].sort();
    for (const userId of sortedUserIds) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
    }

    const conflict = await tx.matchPlayer.findFirst({
      where: {
        userId: { in: playerUserIds },
        match: { status: { in: [...CONFLICTING_MATCH_STATUSES] } },
      },
    });
    if (conflict) {
      throw new ConflictException(
        'One of these players is already in an active or pending match',
      );
    }

    return this.createMatch(game, playerUserIds, tx, stake);
  }

  /** 404s (never 403) for a non-participant — doesn't confirm the match exists. */
  async findByIdForUser(
    userId: string,
    matchId: string,
  ): Promise<MatchWithPlayers> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { players: true },
    });
    if (!match || !match.players.some((p) => p.userId === userId)) {
      throw new NotFoundException('Match not found');
    }
    return match;
  }

  async list(
    userId: string,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<MatchWithPlayers>> {
    return this.listInternal(
      { players: { some: { userId } } },
      { cursor, limit },
    );
  }

  /** Admin visibility: every match, optionally filtered — no participant restriction. */
  async listAdmin(params: {
    gameId?: string;
    status?: Match['status'];
    cursor?: string;
    limit: number;
  }): Promise<CursorPage<MatchWithPlayers>> {
    const { cursor, limit, ...where } = params;
    return this.listInternal(where, { cursor, limit });
  }

  async findByIdAdmin(matchId: string): Promise<MatchWithPlayers> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { players: true },
    });
    if (!match) {
      throw new NotFoundException('Match not found');
    }
    return match;
  }

  private async listInternal(
    where: Prisma.MatchWhereInput,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<MatchWithPlayers>> {
    const matches = await this.prisma.match.findMany({
      where,
      include: { players: true },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = matches.length > limit;
    const items = hasMore ? matches.slice(0, limit) : matches;

    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /**
   * Validates and applies one command against the match's authoritative
   * state. Locks the `Match` row before reading it so two simultaneous
   * submissions against the same match serialize — the loser re-reads
   * the now-current state and correctly rejects (e.g. "not your turn",
   * "this match has already ended") rather than corrupting it or
   * double-processing. Idempotent: a retried submission with the same
   * `commandId` returns the originally-stored result. `type` defaults
   * to `'MOVE'` for backward compatibility with clients that don't send
   * one. Resign/draw-offer/draw-accept/draw-reject (Phase 9 — ADR-024)
   * go through this exact same lock, so they can never race a move or a
   * turn-timeout sweep into a double terminal transition — see
   * `MatchTimeoutService.processTurnTimeout`, which locks the same row.
   */
  async submitCommand(
    userId: string,
    matchId: string,
    commandId: string,
    payload: unknown,
    type: MatchCommandType = 'MOVE',
  ): Promise<MatchCommand> {
    const existing = await this.prisma.matchCommand.findUnique({
      where: { matchId_id: { matchId, id: commandId } },
    });
    if (existing) return existing;

    const drawOfferTimeoutMs = this.configService.get(
      'matches.drawOfferTimeoutMs',
      { infer: true },
    );

    let completedResult: { completed: boolean } | undefined;

    try {
      const { command, match } = await this.prisma.$transaction(async (tx) => {
        // Lock first, then read via the typed API — avoids any ambiguity
        // parsing JSON/enum columns out of a raw query result.
        await tx.$executeRaw`SELECT 1 FROM matches WHERE id = ${matchId} FOR UPDATE`;

        const match = await tx.match.findUnique({
          where: { id: matchId },
          include: { game: true },
        });
        if (!match) {
          throw new NotFoundException('Match not found');
        }

        const player = await tx.matchPlayer.findUnique({
          where: { matchId_userId: { matchId, userId } },
        });
        if (!player) {
          throw new NotFoundException('Match not found');
        }

        const reject = (rejectionReason: string) =>
          tx.matchCommand.create({
            data: {
              id: commandId,
              matchId,
              userId,
              type,
              payload: payload as Prisma.InputJsonValue,
              resultStatus: 'REJECTED',
              rejectionReason,
            },
          });

        if (match.status !== 'ACTIVE') {
          const rejectionReason =
            match.status === 'WAITING'
              ? 'This match has not started yet — both players must confirm their stake first'
              : 'This match has already ended';
          return { command: await reject(rejectionReason), match };
        }

        const gameModule = this.gameRegistry.get(match.gameId);

        if (type === 'RESIGN') {
          if (!gameModule.supportsResignation) {
            return {
              command: await reject('This game does not support resignation'),
              match,
            };
          }
          const opponent = await tx.matchPlayer.findFirst({
            where: { matchId, userId: { not: userId } },
          });
          const updated = await tx.match.update({
            where: { id: matchId },
            data: {
              status: 'COMPLETED',
              completedAt: new Date(),
              winnerUserId: opponent?.userId ?? null,
              resultIsDraw: false,
              terminationReason: 'RESIGNATION',
              turnDeadlineAt: null,
              pendingDrawOfferByUserId: null,
              pendingDrawOfferExpiresAt: null,
            },
          });
          const command = await tx.matchCommand.create({
            data: {
              id: commandId,
              matchId,
              userId,
              type,
              payload: payload as Prisma.InputJsonValue,
              resultStatus: 'ACCEPTED',
              stateVersionAfter: match.stateVersion,
            },
          });
          completedResult = { completed: true };
          return { command, match: updated };
        }

        if (
          type === 'DRAW_OFFER' ||
          type === 'DRAW_ACCEPT' ||
          type === 'DRAW_REJECT'
        ) {
          if (!gameModule.supportsDraws) {
            return {
              command: await reject('This game does not support draw offers'),
              match,
            };
          }

          const now = new Date();
          const offerActive =
            match.pendingDrawOfferByUserId != null &&
            match.pendingDrawOfferExpiresAt != null &&
            match.pendingDrawOfferExpiresAt > now;

          if (type === 'DRAW_OFFER') {
            if (offerActive && match.pendingDrawOfferByUserId !== userId) {
              return {
                command: await reject(
                  'An offer is already pending — accept or reject it instead',
                ),
                match,
              };
            }
            const updated = await tx.match.update({
              where: { id: matchId },
              data: {
                pendingDrawOfferByUserId: userId,
                pendingDrawOfferExpiresAt: new Date(
                  now.getTime() + drawOfferTimeoutMs,
                ),
              },
            });
            const command = await tx.matchCommand.create({
              data: {
                id: commandId,
                matchId,
                userId,
                type,
                payload: payload as Prisma.InputJsonValue,
                resultStatus: 'ACCEPTED',
                stateVersionAfter: match.stateVersion,
              },
            });
            return { command, match: updated };
          }

          if (!offerActive) {
            return {
              command: await reject('No pending draw offer'),
              match,
            };
          }

          if (type === 'DRAW_ACCEPT') {
            if (match.pendingDrawOfferByUserId === userId) {
              return {
                command: await reject('You cannot accept your own draw offer'),
                match,
              };
            }
            const updated = await tx.match.update({
              where: { id: matchId },
              data: {
                status: 'COMPLETED',
                completedAt: new Date(),
                winnerUserId: null,
                resultIsDraw: true,
                terminationReason: 'DRAW_AGREED',
                turnDeadlineAt: null,
                pendingDrawOfferByUserId: null,
                pendingDrawOfferExpiresAt: null,
              },
            });
            const command = await tx.matchCommand.create({
              data: {
                id: commandId,
                matchId,
                userId,
                type,
                payload: payload as Prisma.InputJsonValue,
                resultStatus: 'ACCEPTED',
                stateVersionAfter: match.stateVersion,
              },
            });
            completedResult = { completed: true };
            return { command, match: updated };
          }

          // DRAW_REJECT — usable by either participant: the offerer
          // withdrawing their own offer, or the recipient declining it.
          const updated = await tx.match.update({
            where: { id: matchId },
            data: {
              pendingDrawOfferByUserId: null,
              pendingDrawOfferExpiresAt: null,
            },
          });
          const command = await tx.matchCommand.create({
            data: {
              id: commandId,
              matchId,
              userId,
              type,
              payload: payload as Prisma.InputJsonValue,
              resultStatus: 'ACCEPTED',
              stateVersionAfter: match.stateVersion,
            },
          });
          return { command, match: updated };
        }

        // type === 'MOVE'
        const state = gameModule.deserializeState(match.state);
        const validation = gameModule.validateMove(state, userId, payload);

        if (!validation.valid) {
          return {
            command: await reject(validation.reason ?? 'Invalid move'),
            match,
          };
        }

        const nextState = gameModule.applyMove(state, userId, payload);
        const newStateVersion = match.stateVersion + 1;
        const result = gameModule.getResult(nextState);

        // Refreshed on every accepted move, whoever holds the turn next
        // — this uniformly covers both ordinary turn alternation and
        // Checkers' forced multi-jump continuation (where the same
        // player keeps the turn across several accepted commands): each
        // accepted jump is itself a fresh action boundary, so it's
        // correct for it to restart the clock rather than an accident to
        // guard against. Cleared once the match finishes.
        const turnTimeoutSeconds = match.game.turnTimeoutSeconds;
        const turnDeadlineAt = result
          ? null
          : turnTimeoutSeconds
            ? new Date(Date.now() + turnTimeoutSeconds * 1000)
            : null;

        const updated = await tx.match.update({
          where: { id: matchId },
          data: {
            state: gameModule.serializeState(
              nextState,
            ) as Prisma.InputJsonValue,
            stateVersion: newStateVersion,
            turnDeadlineAt,
            // A move made while a draw offer was outstanding implicitly
            // withdraws it — the offering player chose to keep playing.
            pendingDrawOfferByUserId: null,
            pendingDrawOfferExpiresAt: null,
            ...(result && {
              status: 'COMPLETED',
              completedAt: new Date(),
              resultIsDraw: result.isDraw,
              winnerUserId: result.winnerUserId,
            }),
          },
        });

        const command = await tx.matchCommand.create({
          data: {
            id: commandId,
            matchId,
            userId,
            type,
            payload: payload as Prisma.InputJsonValue,
            resultStatus: 'ACCEPTED',
            stateVersionAfter: newStateVersion,
          },
        });

        completedResult = { completed: Boolean(result) };
        return { command, match: updated };
      }, MATCH_TRANSACTION_OPTIONS);

      this.emitter.emitToMatch(matchId, 'match:state', {
        matchId,
        stateVersion: match.stateVersion,
        state: match.state,
        status: match.status,
        turnDeadlineAt: match.turnDeadlineAt,
        pendingDrawOfferByUserId: match.pendingDrawOfferByUserId,
      });
      if (completedResult?.completed) {
        this.emitter.emitToMatch(matchId, 'match:completed', {
          matchId,
          winnerUserId: match.winnerUserId,
          resultIsDraw: match.resultIsDraw,
          terminationReason: match.terminationReason,
        });
        // Best-effort: the match's own result is already final and
        // committed above regardless of what happens here. A failure is
        // logged inside SettlementService and left for the recovery
        // sweep (MatchTimeoutService) — it must never fail this request,
        // which already correctly reflects the real, authoritative game
        // outcome.
        await this.settlementService.settle(matchId).catch(() => {});
      }

      return command;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const retried = await this.prisma.matchCommand.findUnique({
          where: { matchId_id: { matchId, id: commandId } },
        });
        if (retried) return retried;
      }
      throw error;
    }
  }
}
