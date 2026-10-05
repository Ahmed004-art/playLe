import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { GameRegistry } from './game-registry.service.js';
import type { GameModule } from './contracts/game-module.interface.js';

function fakeModule(gameId: string): GameModule {
  return {
    gameId,
    version: 1,
    minPlayers: 2,
    maxPlayers: 2,
    createInitialState: () => ({}),
    currentTurnUserId: () => null,
    validateMove: () => ({ valid: false }),
    applyMove: (state) => state,
    isFinished: () => false,
    getResult: () => null,
    serializeState: (state) => state as never,
    deserializeState: (json) => json,
  };
}

describe('GameRegistry', () => {
  it('resolves a registered module by gameId', () => {
    const registry = new GameRegistry([fakeModule('tic_tac_toe')]);
    expect(registry.get('tic_tac_toe').gameId).toBe('tic_tac_toe');
    expect(registry.has('tic_tac_toe')).toBe(true);
  });

  it('throws NotFoundException for an unregistered gameId', () => {
    const registry = new GameRegistry([fakeModule('tic_tac_toe')]);
    expect(() => registry.get('checkers')).toThrow(NotFoundException);
    expect(registry.has('checkers')).toBe(false);
  });

  it('supports multiple registered modules', () => {
    const registry = new GameRegistry([
      fakeModule('tic_tac_toe'),
      fakeModule('checkers'),
    ]);
    expect(registry.get('tic_tac_toe').gameId).toBe('tic_tac_toe');
    expect(registry.get('checkers').gameId).toBe('checkers');
  });
});
