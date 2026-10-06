import { Module } from '@nestjs/common';
import { MatchesService } from './matches.service.js';
import { MatchesController } from './matches.controller.js';
import { MatchTimeoutService } from './match-timeout.service.js';
import { GamesModule } from '../games/games.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SettlementModule } from '../settlement/settlement.module.js';
import { MatchStakesModule } from '../match-stakes/match-stakes.module.js';

@Module({
  imports: [
    AuthModule,
    GamesModule,
    RealtimeModule,
    SettlementModule,
    MatchStakesModule,
  ],
  controllers: [MatchesController],
  providers: [MatchesService, MatchTimeoutService],
  exports: [MatchesService],
})
export class MatchesModule {}
