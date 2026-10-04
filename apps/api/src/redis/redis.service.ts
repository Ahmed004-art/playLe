import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { AppConfiguration } from '../config/configuration.js';

/**
 * Redis connection abstraction. Phase 1 establishes connection, health
 * check, and graceful shutdown only. Future uses (documented, not
 * implemented here): matchmaking queues, online presence, temporary game
 * state, rate limiting, distributed locks, pub/sub, temporary session
 * state — see docs/decisions/ADR-005-redis.md.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;

  constructor(
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  onModuleInit(): void {
    const redisConfig = this.configService.get('redis', { infer: true });

    this.client = new Redis({
      host: redisConfig.host,
      port: redisConfig.port,
      password: redisConfig.password,
      lazyConnect: false,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    });

    this.client.on('connect', () =>
      this.logger.log('Redis connection established'),
    );
    this.client.on('error', (error: Error) =>
      this.logger.error(`Redis error: ${error.message}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
    this.logger.log('Redis connection closed');
  }

  getClient(): Redis {
    return this.client;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }
}
