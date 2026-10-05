import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeEmitterService } from './realtime-emitter.service.js';
import { PresenceService } from './presence.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { RedisModule } from '../redis/redis.module.js';

@Module({
  imports: [AuthModule, RedisModule],
  providers: [RealtimeGateway, RealtimeEmitterService, PresenceService],
  exports: [RealtimeEmitterService, PresenceService],
})
export class RealtimeModule {}
