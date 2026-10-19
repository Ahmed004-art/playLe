import { Module } from '@nestjs/common';
import { GamesService } from './games.service.js';
import { GamesController } from './games.controller.js';
import { GameRegistry } from './game-registry.service.js';
import { GAME_MODULES } from './contracts/game-module.interface.js';
import { TicTacToeModule } from './tic-tac-toe/tic-tac-toe.module-impl.js';
import { CheckersModule } from './checkers/checkers.module-impl.js';
import { DiceModule } from './dice/dice.module-impl.js';
import { CryptoDiceRng, DICE_RNG } from './dice/dice-rng.js';
import { AuthModule } from '../auth/auth.module.js';

/**
 * Registering a future game means adding it to this `useFactory` array —
 * no change to `GameRegistry`, `MatchesService`, or any other generic
 * platform code. See docs/decisions/ADR-015-game-module-architecture.md.
 */
@Module({
  imports: [AuthModule],
  controllers: [GamesController],
  providers: [
    GamesService,
    TicTacToeModule,
    CheckersModule,
    { provide: DICE_RNG, useClass: CryptoDiceRng },
    DiceModule,
    {
      provide: GAME_MODULES,
      inject: [TicTacToeModule, CheckersModule, DiceModule],
      useFactory: (
        ticTacToe: TicTacToeModule,
        checkers: CheckersModule,
        dice: DiceModule,
      ) => [ticTacToe, checkers, dice],
    },
    GameRegistry,
  ],
  exports: [GamesService, GameRegistry],
})
export class GamesModule {}
