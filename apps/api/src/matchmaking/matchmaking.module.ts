import { Module } from '@nestjs/common';
import { MatchmakingService } from './matchmaking.service.js';
import { MatchmakingController } from './matchmaking.controller.js';
import { GamesModule } from '../games/games.module.js';
import { MatchesModule } from '../matches/matches.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MatchStakesModule } from '../match-stakes/match-stakes.module.js';

@Module({
  imports: [
    AuthModule,
    GamesModule,
    MatchesModule,
    RealtimeModule,
    RedisModule,
    MatchStakesModule,
  ],
  controllers: [MatchmakingController],
  providers: [MatchmakingService],
})
export class MatchmakingModule {}
