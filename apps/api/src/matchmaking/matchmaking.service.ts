import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { GamesService } from '../games/games.service.js';
import { MatchesService } from '../matches/matches.service.js';
import { RealtimeEmitterService } from '../realtime/realtime-emitter.service.js';
import { PresenceService } from '../realtime/presence.service.js';

export type JoinResult =
  { status: 'QUEUED' } | { status: 'MATCHED'; matchId: string };

const QUEUED_USERS_KEY = 'matchmaking:queued-users';
const queueKeyFor = (gameId: string): string => `matchmaking:queue:${gameId}`;

/**
 * Atomically checks the queue length and pops exactly `n` entries only if
 * that many are present — this single Lua script is what prevents two
 * concurrent `join` calls from both reading "enough players are
 * waiting" and forming two matches out of the same people. See
 * docs/decisions/ADR-015-game-module-architecture.md (concurrency).
 */
const TRY_MATCH_SCRIPT = `
local queueKey = KEYS[1]
local n = tonumber(ARGV[1])
local len = redis.call('LLEN', queueKey)
if len < n then
  return {}
end
local result = {}
for i = 1, n do
  table.insert(result, redis.call('LPOP', queueKey))
end
return result
`;

@Injectable()
export class MatchmakingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly gamesService: GamesService,
    private readonly matchesService: MatchesService,
    private readonly emitter: RealtimeEmitterService,
    private readonly presenceService: PresenceService,
  ) {}

  async join(gameId: string, userId: string): Promise<JoinResult> {
    const game = await this.gamesService.findEnabledById(gameId);

    const alreadyInMatch = await this.prisma.matchPlayer.findFirst({
      where: { userId, match: { status: 'ACTIVE' } },
    });
    if (alreadyInMatch) {
      throw new ConflictException('You are already in an active match');
    }

    const redis = this.redisService.getClient();

    // Atomic "claim" of this user's queue slot — HSETNX prevents the
    // same user from being queued twice by a double-submitted request.
    const claimed = await redis.hsetnx(QUEUED_USERS_KEY, userId, gameId);
    if (claimed === 0) {
      throw new ConflictException('Already searching for a match');
    }

    await redis.rpush(queueKeyFor(gameId), userId);
    await this.presenceService.set(userId, 'SEARCHING').catch(() => {});

    const popped = (await redis.eval(
      TRY_MATCH_SCRIPT,
      1,
      queueKeyFor(gameId),
      game.minPlayers,
    )) as string[];

    if (popped.length === 0) {
      return { status: 'QUEUED' };
    }

    await redis.hdel(QUEUED_USERS_KEY, ...popped);

    const match = await this.matchesService.createMatch(game, popped);

    for (const matchedUserId of popped) {
      await this.presenceService.set(matchedUserId, 'IN_MATCH').catch(() => {});
      this.emitter.emitToUser(matchedUserId, 'match:found', {
        matchId: match.id,
        gameId: game.id,
      });
    }

    return { status: 'MATCHED', matchId: match.id };
  }

  async leave(gameId: string, userId: string): Promise<void> {
    const redis = this.redisService.getClient();
    const queuedGameId = await redis.hget(QUEUED_USERS_KEY, userId);
    if (queuedGameId !== gameId) {
      // Not currently queued for this game — idempotent no-op (may
      // already have been matched or already left).
      return;
    }
    await redis.hdel(QUEUED_USERS_KEY, userId);
    await redis.lrem(queueKeyFor(gameId), 0, userId);
    await this.presenceService.set(userId, 'ONLINE').catch(() => {});
  }
}
