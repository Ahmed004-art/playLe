import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import configuration, { AppConfiguration } from './config/configuration.js';
import { validate } from './config/env.validation.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';
import { HealthModule } from './health/health.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { UsersModule } from './users/users.module.js';
import { AuthModule } from './auth/auth.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
      load: [configuration],
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfiguration, true>) => ({
        throttlers: [
          {
            name: 'default',
            ttl: configService.get('throttle.ttlMs', { infer: true }),
            limit: configService.get('throttle.limit', { infer: true }),
          },
          {
            // Stricter, separately-configurable limit for credential-guessing-sensitive
            // routes (register/login) — see docs/decisions/ADR-011-authentication.md.
            name: 'auth',
            ttl: configService.get('auth.throttleTtlMs', { infer: true }),
            limit: configService.get('auth.throttleLimit', { infer: true }),
          },
        ],
      }),
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
    RealtimeModule,
    UsersModule,
    AuthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
