import { Injectable, NotFoundException } from '@nestjs/common';
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
import { MATCH_TRANSACTION_OPTIONS } from '../common/prisma-transaction.constants.js';
import type { CursorPage } from '../common/dto/pagination.dto.js';

export type MatchWithPlayers = Match & { players: MatchPlayer[] };

/**
 * Prisma client or interactive-transaction client — accepted so a caller
 * can create a match atomically with its own state change (e.g.
 * `ChallengesService.accept`).
 */
export type PrismaClientOrTx = Pick<PrismaService, 'match'>;

@Injectable()
export class MatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gameRegistry: GameRegistry,
    private readonly emitter: RealtimeEmitterService,
  ) {}

  /**
   * The only place a `Match` is created. Both players are already known
   * (matchmaking just formed a pair, or a challenge was just accepted),
   * so for this phase's 2-player games the match starts `ACTIVE`
   * immediately — there is no real waiting-room window to persist as
   * `WAITING` (see docs/decisions/ADR-015-game-module-architecture.md).
   * Accepts an optional transaction client so a caller (e.g.
   * `ChallengesService.accept`) can create the match atomically with its
   * own state change; defaults to the plain `PrismaService`.
   */
  async createMatch(
    game: Game,
    playerUserIds: string[],
    tx: PrismaClientOrTx = this.prisma,
  ): Promise<MatchWithPlayers> {
    const module = this.gameRegistry.get(game.id);
    const initialState = module.createInitialState(playerUserIds);
    const now = new Date();

    return tx.match.create({
      data: {
        gameId: game.id,
        gameVersion: game.version,
        status: 'ACTIVE',
        state: module.serializeState(initialState) as Prisma.InputJsonValue,
        readyAt: now,
        startedAt: now,
        players: {
          create: playerUserIds.map((userId, seat) => ({ userId, seat })),
        },
      },
      include: { players: true },
    });
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
   * the now-current state and correctly rejects (e.g. "not your turn")
   * rather than corrupting it. Idempotent: a retried submission with the
   * same `commandId` returns the originally-stored result.
   */
  async submitCommand(
    userId: string,
    matchId: string,
    commandId: string,
    payload: unknown,
  ): Promise<MatchCommand> {
    const existing = await this.prisma.matchCommand.findUnique({
      where: { matchId_id: { matchId, id: commandId } },
    });
    if (existing) return existing;

    let completedResult: { completed: boolean } | undefined;

    try {
      const { command, match } = await this.prisma.$transaction(async (tx) => {
        // Lock first, then read via the typed API — avoids any ambiguity
        // parsing JSON/enum columns out of a raw query result.
        await tx.$executeRaw`SELECT 1 FROM matches WHERE id = ${matchId} FOR UPDATE`;

        const match = await tx.match.findUnique({ where: { id: matchId } });
        if (!match) {
          throw new NotFoundException('Match not found');
        }

        const player = await tx.matchPlayer.findUnique({
          where: { matchId_userId: { matchId, userId } },
        });
        if (!player) {
          throw new NotFoundException('Match not found');
        }

        if (match.status !== 'ACTIVE') {
          const command = await tx.matchCommand.create({
            data: {
              id: commandId,
              matchId,
              userId,
              type: 'MOVE',
              payload: payload as Prisma.InputJsonValue,
              resultStatus: 'REJECTED',
              rejectionReason: 'This match has already ended',
            },
          });
          return { command, match };
        }

        const gameModule = this.gameRegistry.get(match.gameId);
        const state = gameModule.deserializeState(match.state);
        const validation = gameModule.validateMove(state, userId, payload);

        if (!validation.valid) {
          const command = await tx.matchCommand.create({
            data: {
              id: commandId,
              matchId,
              userId,
              type: 'MOVE',
              payload: payload as Prisma.InputJsonValue,
              resultStatus: 'REJECTED',
              rejectionReason: validation.reason ?? 'Invalid move',
            },
          });
          return { command, match };
        }

        const nextState = gameModule.applyMove(state, userId, payload);
        const newStateVersion = match.stateVersion + 1;
        const result = gameModule.getResult(nextState);

        const updated = await tx.match.update({
          where: { id: matchId },
          data: {
            state: gameModule.serializeState(
              nextState,
            ) as Prisma.InputJsonValue,
            stateVersion: newStateVersion,
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
            type: 'MOVE',
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
      });
      if (completedResult?.completed) {
        this.emitter.emitToMatch(matchId, 'match:completed', {
          matchId,
          winnerUserId: match.winnerUserId,
          resultIsDraw: match.resultIsDraw,
        });
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
