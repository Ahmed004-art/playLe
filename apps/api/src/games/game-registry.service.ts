import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  GAME_MODULES,
  type GameModule,
} from './contracts/game-module.interface.js';

/**
 * The only thing `MatchesService` consults to get game-specific
 * behavior — collects every bound `GameModule` into a lookup map so the
 * generic match/command pipeline never branches on `gameId` itself. See
 * docs/decisions/ADR-015-game-module-architecture.md.
 */
@Injectable()
export class GameRegistry {
  private readonly modules = new Map<string, GameModule>();

  constructor(@Inject(GAME_MODULES) modules: GameModule[]) {
    for (const module of modules) {
      this.modules.set(module.gameId, module);
    }
  }

  get(gameId: string): GameModule {
    const module = this.modules.get(gameId);
    if (!module) {
      throw new NotFoundException(`No game module registered for "${gameId}"`);
    }
    return module;
  }

  has(gameId: string): boolean {
    return this.modules.has(gameId);
  }
}
