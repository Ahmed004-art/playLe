import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  GameModule,
  GameResult,
  MoveValidationResult,
} from '../contracts/game-module.interface.js';
import {
  BOARD_SIZE,
  WIN_LINES,
  type TicTacToeMove,
  type TicTacToeState,
} from './tic-tac-toe.types.js';

/**
 * Server-authoritative Tic-Tac-Toe rules. Pure, dependency-free, and
 * fully unit-testable without Nest or a database — see
 * `tic-tac-toe.module-impl.spec.ts`. Never trusts a client-supplied
 * winner/turn/result; every one of those is derived here from the
 * authoritative state.
 */
@Injectable()
export class TicTacToeModule implements GameModule<
  TicTacToeState,
  TicTacToeMove
> {
  readonly gameId = 'tic_tac_toe';
  readonly version = 1;
  readonly minPlayers = 2;
  readonly maxPlayers = 2;

  createInitialState(playerUserIds: string[]): TicTacToeState {
    if (playerUserIds.length !== 2) {
      throw new Error('Tic-Tac-Toe requires exactly 2 players');
    }
    return {
      board: new Array<string | null>(BOARD_SIZE).fill(null),
      playerOrder: [playerUserIds[0], playerUserIds[1]],
      moveCount: 0,
      winnerUserId: null,
      isDraw: false,
    };
  }

  currentTurnUserId(state: TicTacToeState): string | null {
    if (this.isFinished(state)) return null;
    return state.playerOrder[state.moveCount % 2];
  }

  validateMove(
    state: TicTacToeState,
    userId: string,
    move: unknown,
  ): MoveValidationResult {
    if (this.isFinished(state)) {
      return { valid: false, reason: 'This match has already ended' };
    }
    if (!state.playerOrder.includes(userId)) {
      return {
        valid: false,
        reason: 'You are not a participant in this match',
      };
    }
    if (this.currentTurnUserId(state) !== userId) {
      return { valid: false, reason: 'It is not your turn' };
    }

    const cell = this.extractCell(move);
    if (cell === null) {
      return { valid: false, reason: 'That move is not valid' };
    }
    if (state.board[cell] !== null) {
      return { valid: false, reason: 'That cell is already occupied' };
    }

    return { valid: true };
  }

  applyMove(
    state: TicTacToeState,
    userId: string,
    move: TicTacToeMove,
  ): TicTacToeState {
    const cell = move.cell;
    const board = [...state.board];
    board[cell] = userId;
    const moveCount = state.moveCount + 1;

    const winnerUserId = this.checkWinner(board);
    const isDraw = winnerUserId === null && moveCount === BOARD_SIZE;

    return { ...state, board, moveCount, winnerUserId, isDraw };
  }

  isFinished(state: TicTacToeState): boolean {
    return state.winnerUserId !== null || state.isDraw;
  }

  getResult(state: TicTacToeState): GameResult | null {
    if (!this.isFinished(state)) return null;
    return { winnerUserId: state.winnerUserId, isDraw: state.isDraw };
  }

  serializeState(state: TicTacToeState): Prisma.JsonValue {
    return state as unknown as Prisma.JsonValue;
  }

  deserializeState(json: Prisma.JsonValue): TicTacToeState {
    return json as unknown as TicTacToeState;
  }

  private extractCell(move: unknown): number | null {
    if (
      typeof move !== 'object' ||
      move === null ||
      !('cell' in move) ||
      typeof move.cell !== 'number'
    ) {
      return null;
    }
    const cell = (move as TicTacToeMove).cell;
    if (!Number.isInteger(cell) || cell < 0 || cell >= BOARD_SIZE) {
      return null;
    }
    return cell;
  }

  private checkWinner(board: (string | null)[]): string | null {
    for (const [a, b, c] of WIN_LINES) {
      const mark = board[a];
      if (mark !== null && mark === board[b] && mark === board[c]) {
        return mark;
      }
    }
    return null;
  }
}
