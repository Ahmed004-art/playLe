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
 * user's own current match opponent (see `MatchesService`), never as a
 * general lookup-any-user endpoint.
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

  async clear(userId: string): Promise<void> {
    await this.redisService.getClient().del(keyFor(userId));
  }
}
