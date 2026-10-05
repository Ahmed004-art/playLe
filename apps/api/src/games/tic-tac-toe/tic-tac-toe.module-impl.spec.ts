import { beforeEach, describe, expect, it } from 'vitest';
import { TicTacToeModule } from './tic-tac-toe.module-impl.js';
import type { TicTacToeState } from './tic-tac-toe.types.js';

const PLAYER_X = 'player-x';
const PLAYER_O = 'player-o';

describe('TicTacToeModule', () => {
  let module: TicTacToeModule;
  let state: TicTacToeState;

  beforeEach(() => {
    module = new TicTacToeModule();
    state = module.createInitialState([PLAYER_X, PLAYER_O]);
  });

  it('exposes stable metadata', () => {
    expect(module.gameId).toBe('tic_tac_toe');
    expect(module.minPlayers).toBe(2);
    expect(module.maxPlayers).toBe(2);
  });

  it('creates an empty board with the first player to move', () => {
    expect(state.board).toEqual(new Array(9).fill(null));
    expect(module.currentTurnUserId(state)).toBe(PLAYER_X);
    expect(module.isFinished(state)).toBe(false);
  });

  it('rejects a move from a non-participant', () => {
    const result = module.validateMove(state, 'someone-else', { cell: 0 });
    expect(result).toEqual({
      valid: false,
      reason: 'You are not a participant in this match',
    });
  });

  it('rejects a move out of turn', () => {
    const result = module.validateMove(state, PLAYER_O, { cell: 0 });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not your turn/i);
  });

  it('rejects a malformed move payload', () => {
    expect(module.validateMove(state, PLAYER_X, {}).valid).toBe(false);
    expect(module.validateMove(state, PLAYER_X, { cell: 'four' }).valid).toBe(
      false,
    );
    expect(module.validateMove(state, PLAYER_X, { cell: -1 }).valid).toBe(
      false,
    );
    expect(module.validateMove(state, PLAYER_X, { cell: 9 }).valid).toBe(false);
    expect(module.validateMove(state, PLAYER_X, null).valid).toBe(false);
  });

  it('accepts a legal move and alternates turns', () => {
    expect(module.validateMove(state, PLAYER_X, { cell: 4 }).valid).toBe(true);
    state = module.applyMove(state, PLAYER_X, { cell: 4 });

    expect(state.board[4]).toBe(PLAYER_X);
    expect(state.moveCount).toBe(1);
    expect(module.currentTurnUserId(state)).toBe(PLAYER_O);
  });

  it('rejects a move onto an occupied cell', () => {
    state = module.applyMove(state, PLAYER_X, { cell: 0 });
    const result = module.validateMove(state, PLAYER_O, { cell: 0 });
    expect(result).toEqual({
      valid: false,
      reason: 'That cell is already occupied',
    });
  });

  function play(moves: [string, number][]): TicTacToeState {
    let s = module.createInitialState([PLAYER_X, PLAYER_O]);
    for (const [player, cell] of moves) {
      const validation = module.validateMove(s, player, { cell });
      expect(validation.valid).toBe(true);
      s = module.applyMove(s, player, { cell });
    }
    return s;
  }

  it('detects a horizontal win', () => {
    // X: 0,1,2 ; O: 3,4
    state = play([
      [PLAYER_X, 0],
      [PLAYER_O, 3],
      [PLAYER_X, 1],
      [PLAYER_O, 4],
      [PLAYER_X, 2],
    ]);
    expect(module.isFinished(state)).toBe(true);
    expect(module.getResult(state)).toEqual({
      winnerUserId: PLAYER_X,
      isDraw: false,
    });
  });

  it('detects a vertical win', () => {
    state = play([
      [PLAYER_X, 0],
      [PLAYER_O, 1],
      [PLAYER_X, 3],
      [PLAYER_O, 2],
      [PLAYER_X, 6],
    ]);
    expect(module.getResult(state)).toEqual({
      winnerUserId: PLAYER_X,
      isDraw: false,
    });
  });

  it('detects a diagonal win', () => {
    state = play([
      [PLAYER_X, 0],
      [PLAYER_O, 1],
      [PLAYER_X, 4],
      [PLAYER_O, 2],
      [PLAYER_X, 8],
    ]);
    expect(module.getResult(state)).toEqual({
      winnerUserId: PLAYER_X,
      isDraw: false,
    });
  });

  it('detects the anti-diagonal win', () => {
    state = play([
      [PLAYER_X, 2],
      [PLAYER_O, 0],
      [PLAYER_X, 4],
      [PLAYER_O, 1],
      [PLAYER_X, 6],
    ]);
    expect(module.getResult(state)).toEqual({
      winnerUserId: PLAYER_X,
      isDraw: false,
    });
  });

  it('detects a draw when the board fills with no winner', () => {
    // X O X / X O O / O X X -> no line wins, board full
    state = play([
      [PLAYER_X, 0],
      [PLAYER_O, 1],
      [PLAYER_X, 2],
      [PLAYER_O, 4],
      [PLAYER_X, 3],
      [PLAYER_O, 5],
      [PLAYER_X, 7],
      [PLAYER_O, 6],
      [PLAYER_X, 8],
    ]);
    expect(module.isFinished(state)).toBe(true);
    expect(module.getResult(state)).toEqual({
      winnerUserId: null,
      isDraw: true,
    });
  });

  it('rejects any move once the game has finished', () => {
    state = play([
      [PLAYER_X, 0],
      [PLAYER_O, 3],
      [PLAYER_X, 1],
      [PLAYER_O, 4],
      [PLAYER_X, 2],
    ]);
    const result = module.validateMove(state, PLAYER_O, { cell: 5 });
    expect(result).toEqual({
      valid: false,
      reason: 'This match has already ended',
    });
  });

  it('round-trips state through serialize/deserialize', () => {
    state = module.applyMove(state, PLAYER_X, { cell: 4 });
    const json = module.serializeState(state);
    const restored = module.deserializeState(json);
    expect(restored).toEqual(state);
  });
});
