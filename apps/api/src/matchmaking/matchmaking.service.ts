import { ConflictException, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { GamesService } from '../games/games.service.js';
import { MatchesService, type StakeSpec } from '../matches/matches.service.js';
import { RealtimeEmitterService } from '../realtime/realtime-emitter.service.js';
import { PresenceService } from '../realtime/presence.service.js';
import { MatchStakesService } from '../match-stakes/match-stakes.service.js';
import type { StakeRequestDto } from '../match-stakes/dto/stake-request.dto.js';

export type JoinResult =
  { status: 'QUEUED' } | { status: 'MATCHED'; matchId: string };

const QUEUED_USERS_KEY = 'matchmaking:queued-users';

/**
 * A free-play queue key is unchanged from Phase 4 (`matchmaking:queue:
 * {gameId}`) — zero behavior change for existing free-play clients. A
 * staked queue key additionally segments by currency+amount, since only
 * players who requested the identical stake can ever be paired (equal-
 * stake is enforced by construction — see
 * docs/decisions/ADR-016-match-financial-architecture.md).
 */
const queueKeyFor = (gameId: string, stake?: StakeSpec): string =>
  stake
    ? `matchmaking:queue:${gameId}:${stake.currency}:${stake.amountMinor}`
    : `matchmaking:queue:${gameId}`;

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
    private readonly matchStakesService: MatchStakesService,
  ) {}

  async join(
    gameId: string,
    user: User,
    stakeRequest?: StakeRequestDto,
  ): Promise<JoinResult> {
    const userId = user.id;
    const game = await this.gamesService.findEnabledById(gameId);

    const alreadyInMatch = await this.prisma.matchPlayer.findFirst({
      where: { userId, match: { status: 'ACTIVE' } },
    });
    if (alreadyInMatch) {
      throw new ConflictException('You are already in an active match');
    }

    const stake = stakeRequest
      ? await this.matchStakesService.validateStakeRequest(user, stakeRequest)
      : undefined;

    const redis = this.redisService.getClient();
    const queueKey = queueKeyFor(gameId, stake);

    // Atomic "claim" of this user's queue slot — HSETNX prevents the
    // same user from being queued twice by a double-submitted request,
    // for any queue (free or staked).
    const claimed = await redis.hsetnx(QUEUED_USERS_KEY, userId, queueKey);
    if (claimed === 0) {
      throw new ConflictException('Already searching for a match');
    }

    await redis.rpush(queueKey, userId);
    await this.presenceService.set(userId, 'SEARCHING').catch(() => {});

    const popped = (await redis.eval(
      TRY_MATCH_SCRIPT,
      1,
      queueKey,
      game.minPlayers,
    )) as string[];

    if (popped.length === 0) {
      return { status: 'QUEUED' };
    }

    await redis.hdel(QUEUED_USERS_KEY, ...popped);

    const match = await this.matchesService.createMatch(
      game,
      popped,
      undefined,
      stake,
    );

    for (const matchedUserId of popped) {
      await this.presenceService.set(matchedUserId, 'IN_MATCH').catch(() => {});
      this.emitter.emitToUser(matchedUserId, 'match:found', {
        matchId: match.id,
        gameId: game.id,
      });
    }

    return { status: 'MATCHED', matchId: match.id };
  }

  /** `gameId` is accepted for API-shape stability but no longer needed
   * to find the right queue — the user's queue key (free or staked) is
   * already recorded against their own id at join time. */
  async leave(userId: string): Promise<void> {
    const redis = this.redisService.getClient();
    const queueKey = await redis.hget(QUEUED_USERS_KEY, userId);
    if (!queueKey) {
      // Not currently queued — idempotent no-op (may already have been
      // matched or already left).
      return;
    }
    await redis.hdel(QUEUED_USERS_KEY, userId);
    await redis.lrem(queueKey, 0, userId);
    await this.presenceService.set(userId, 'ONLINE').catch(() => {});
  }
}
