import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

interface HealthCheckResult {
  status: 'ok' | 'error';
  timestamp: string;
  checks: {
    postgres: 'up' | 'down';
    redis: 'up' | 'down';
  };
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Writes the response directly (bypassing the global exception filter)
   * because a degraded health report is a status payload for infra
   * tooling, not an API error — throwing an HttpException here would let
   * the global filter normalize it into a generic
   * `{ message: "Internal server error" }` body and discard the actual
   * postgres/redis status, which is the whole point of this endpoint.
   * Discovered by calling this endpoint live against a real database.
   */
  @Get()
  @ApiOperation({ summary: 'Reports API, PostgreSQL, and Redis health.' })
  async check(@Res() res: Response): Promise<void> {
    const [postgresHealthy, redisHealthy] = await Promise.all([
      this.prisma.isHealthy(),
      this.redis.isHealthy(),
    ]);

    const result: HealthCheckResult = {
      status: postgresHealthy && redisHealthy ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      checks: {
        postgres: postgresHealthy ? 'up' : 'down',
        redis: redisHealthy ? 'up' : 'down',
      },
    };

    const statusCode =
      result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
    res.status(statusCode).json(result);
  }
}
