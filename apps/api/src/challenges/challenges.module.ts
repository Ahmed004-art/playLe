import { Module } from '@nestjs/common';
import { ChallengesService } from './challenges.service.js';
import { ChallengesController } from './challenges.controller.js';
import { GamesModule } from '../games/games.module.js';
import { MatchesModule } from '../matches/matches.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MatchStakesModule } from '../match-stakes/match-stakes.module.js';

@Module({
  imports: [
    AuthModule,
    GamesModule,
    MatchesModule,
    RealtimeModule,
    MatchStakesModule,
  ],
  controllers: [ChallengesController],
  providers: [ChallengesService],
})
export class ChallengesModule {}
