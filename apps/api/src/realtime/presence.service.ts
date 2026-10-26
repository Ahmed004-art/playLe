import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

export type PresenceStatus = 'ONLINE' | 'IN_MATCH' | 'SEARCHING';

const TTL_SECONDS = 30;
const keyFor = (userId: string): string => `presence:${userId}`;

/**
 * Ephemeral, Redis-backed presence — never persisted or treated as
 * durable user data (see ADR-005). A key simply expires if nobody
 * refreshes it, so a crashed/killed connection "goes offline" on its
 * own without needing an explicit cleanup step. Only exposed for a
 * user's own current match opponent (see `MatchesService`) and, since
 * Phase 12 PR 3, for their accepted and unblocked friends (see
 * `FriendsService.listFriends`, ADR-026) - never as a general
 * lookup-any-user endpoint, and no endpoint takes a caller-supplied id list.
 */
@Injectable()
export class PresenceService {
  constructor(private readonly redisService: RedisService) {}

  async set(userId: string, status: PresenceStatus): Promise<void> {
    await this.redisService
      .getClient()
      .set(keyFor(userId), status, 'EX', TTL_SECONDS);
  }

  /** Refreshes the TTL without changing the stored status. */
  async touch(userId: string): Promise<void> {
    await this.redisService.getClient().expire(keyFor(userId), TTL_SECONDS);
  }

  async get(userId: string): Promise<PresenceStatus | null> {
    const value = await this.redisService.getClient().get(keyFor(userId));
    return value as PresenceStatus | null;
  }

  /**
   * Presence for many users in ONE Redis round trip (`MGET`), never one call
   * per user. Every id asked for is present in the result; `null` means no
   * presence key (offline). A stored value that is not a known status is
   * treated as offline rather than passed through. Throws if Redis is
   * unreachable - callers decide what "unknown" means (friends show OFFLINE).
   * Callers must only pass ids they are entitled to see presence for; this
   * method does no access check of its own.
   */
  async getMany(
    userIds: string[],
  ): Promise<Map<string, PresenceStatus | null>> {
    const result = new Map<string, PresenceStatus | null>();
    if (userIds.length === 0) return result;

    const values = await this.redisService
      .getClient()
      .mget(...userIds.map(keyFor));
    userIds.forEach((userId, index) => {
      const value = values[index];
      result.set(
        userId,
        value === 'ONLINE' || value === 'IN_MATCH' || value === 'SEARCHING'
          ? value
          : null,
      );
    });
    return result;
  }

  async clear(userId: string): Promise<void> {
    await this.redisService.getClient().del(keyFor(userId));
  }
}
