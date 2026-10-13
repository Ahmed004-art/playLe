import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  GameModule,
  GameResult,
  MoveValidationResult,
} from '../contracts/game-module.interface.js';
import {
  BOARD_SIZE,
  DRAW_NO_PROGRESS_LIMIT,
  type CheckersMove,
  type CheckersPiece,
  type CheckersState,
  type Coord,
} from './checkers.types.js';

type Board = (CheckersPiece | null)[][];

const DIAGONAL_DIRS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

/**
 * Server-authoritative standard American/English checkers rules. Pure,
 * dependency-free, and fully unit-testable without Nest or a database —
 * see `checkers.module-impl.spec.ts`. Never trusts a client-supplied
 * turn/capture/winner — every one of those is derived here from the
 * authoritative state. Rule choices (promotion ends the turn; the
 * 40-move no-progress draw) are documented in
 * docs/decisions/ADR-022-checkers-game-module.md.
 */
@Injectable()
export class CheckersModule implements GameModule<CheckersState, CheckersMove> {
  readonly gameId = 'checkers';
  readonly version = 1;
  readonly minPlayers = 2;
  readonly maxPlayers = 2;
  readonly supportsResignation = true;
  readonly supportsDraws = true;

  createInitialState(playerUserIds: string[]): CheckersState {
    if (playerUserIds.length !== 2) {
      throw new Error('Checkers requires exactly 2 players');
    }
    const [p0, p1] = playerUserIds;
    const board: Board = Array.from({ length: BOARD_SIZE }, () =>
      new Array<CheckersPiece | null>(BOARD_SIZE).fill(null),
    );
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (!this.isDarkSquare(row, col)) continue;
        if (row <= 2) board[row][col] = { owner: p0, king: false };
        else if (row >= BOARD_SIZE - 3) {
          board[row][col] = { owner: p1, king: false };
        }
      }
    }

    return {
      board,
      playerOrder: [p0, p1],
      currentTurn: p0,
      mustContinueFrom: null,
      movesSinceProgress: 0,
      winnerUserId: null,
      isDraw: false,
    };
  }

  currentTurnUserId(state: CheckersState): string | null {
    if (this.isFinished(state)) return null;
    return state.currentTurn;
  }

  validateMove(
    state: CheckersState,
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

    const parsed = this.extractMove(move);
    if (!parsed) {
      return { valid: false, reason: 'That move is not valid' };
    }
    const { from, to } = parsed;

    const piece = state.board[from.row][from.col];
    if (!piece || piece.owner !== userId) {
      return {
        valid: false,
        reason: 'You do not have a piece of yours at that square',
      };
    }

    if (
      state.mustContinueFrom &&
      (state.mustContinueFrom.row !== from.row ||
        state.mustContinueFrom.col !== from.col)
    ) {
      return {
        valid: false,
        reason: 'You must continue jumping with the same piece',
      };
    }

    if (!this.isDarkSquare(to.row, to.col) || state.board[to.row][to.col]) {
      return {
        valid: false,
        reason: 'The destination must be an empty playable square',
      };
    }

    const dr = to.row - from.row;
    const dc = to.col - from.col;
    if (
      Math.abs(dr) !== Math.abs(dc) ||
      (Math.abs(dr) !== 1 && Math.abs(dr) !== 2)
    ) {
      return {
        valid: false,
        reason: 'A move must be diagonal by exactly one or two squares',
      };
    }

    const forwardDir = this.forwardDirectionFor(state.playerOrder, userId);

    if (Math.abs(dr) === 1) {
      if (state.mustContinueFrom) {
        return {
          valid: false,
          reason: 'You must continue capturing, not make a simple move',
        };
      }
      if (!piece.king && dr !== forwardDir) {
        return {
          valid: false,
          reason: 'A man may only move diagonally forward',
        };
      }
      if (this.hasAnyCaptureForPlayer(state, userId)) {
        return {
          valid: false,
          reason: 'A capture is available and must be taken',
        };
      }
      return { valid: true };
    }

    // A jump (|dr| === 2): the midpoint must hold exactly one opposing
    // piece, and a man may only capture diagonally forward.
    const midRow = from.row + dr / 2;
    const midCol = from.col + dc / 2;
    const midPiece = state.board[midRow][midCol];
    if (!midPiece || midPiece.owner === userId) {
      return {
        valid: false,
        reason: 'There is no piece to capture on that diagonal',
      };
    }
    if (!piece.king && dr / 2 !== forwardDir) {
      return {
        valid: false,
        reason: 'A man may only capture diagonally forward',
      };
    }
    return { valid: true };
  }

  applyMove(
    state: CheckersState,
    userId: string,
    move: CheckersMove,
  ): CheckersState {
    const { from, to } = move;
    const board = this.cloneBoard(state.board);
    const piece = board[from.row][from.col]!;
    const dr = to.row - from.row;
    const dc = to.col - from.col;
    const isJump = Math.abs(dr) === 2;

    board[from.row][from.col] = null;
    if (isJump) {
      board[from.row + dr / 2][from.col + dc / 2] = null;
    }

    const opponentBackRow =
      userId === state.playerOrder[0] ? BOARD_SIZE - 1 : 0;
    const promoted = !piece.king && to.row === opponentBackRow;
    board[to.row][to.col] = { owner: userId, king: piece.king || promoted };

    // A piece that is promoted on a jump stops there — it never
    // continues the same multi-jump sequence as a king, even if a
    // further king-move capture would otherwise be available. See
    // ADR-022 "Promotion ends the turn".
    const mustContinueFrom: Coord | null =
      isJump &&
      !promoted &&
      this.hasCaptureFromSquare(board, to, userId, state.playerOrder)
        ? to
        : null;

    const nextTurn =
      mustContinueFrom === null
        ? userId === state.playerOrder[0]
          ? state.playerOrder[1]
          : state.playerOrder[0]
        : userId;

    const progressMade = isJump || !piece.king;
    const movesSinceProgress = progressMade ? 0 : state.movesSinceProgress + 1;

    let next: CheckersState = {
      ...state,
      board,
      currentTurn: nextTurn,
      mustContinueFrom,
      movesSinceProgress,
    };

    if (!this.hasAnyLegalMoveForPlayer(next, nextTurn)) {
      next = {
        ...next,
        winnerUserId:
          nextTurn === state.playerOrder[0]
            ? state.playerOrder[1]
            : state.playerOrder[0],
      };
    } else if (movesSinceProgress >= DRAW_NO_PROGRESS_LIMIT) {
      next = { ...next, isDraw: true };
    }

    return next;
  }

  isFinished(state: CheckersState): boolean {
    return state.winnerUserId !== null || state.isDraw;
  }

  getResult(state: CheckersState): GameResult | null {
    if (!this.isFinished(state)) return null;
    return { winnerUserId: state.winnerUserId, isDraw: state.isDraw };
  }

  serializeState(state: CheckersState): Prisma.JsonValue {
    return state as unknown as Prisma.JsonValue;
  }

  deserializeState(json: Prisma.JsonValue): CheckersState {
    return json as unknown as CheckersState;
  }

  private isDarkSquare(row: number, col: number): boolean {
    return (row + col) % 2 === 1;
  }

  private inBounds(row: number, col: number): boolean {
    return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
  }

  private forwardDirectionFor(
    playerOrder: [string, string],
    userId: string,
  ): 1 | -1 {
    return userId === playerOrder[0] ? 1 : -1;
  }

  private directionsFor(
    piece: CheckersPiece,
    forwardDir: number,
  ): (readonly [number, number])[] {
    if (piece.king) return [...DIAGONAL_DIRS];
    return DIAGONAL_DIRS.filter(([dr]) => dr === forwardDir);
  }

  private cloneBoard(board: Board): Board {
    return board.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
  }

  private hasCaptureFromSquare(
    board: Board,
    coord: Coord,
    userId: string,
    playerOrder: [string, string],
  ): boolean {
    const piece = board[coord.row][coord.col];
    if (!piece || piece.owner !== userId) return false;
    const forwardDir = this.forwardDirectionFor(playerOrder, userId);
    for (const [dr, dc] of this.directionsFor(piece, forwardDir)) {
      const landRow = coord.row + dr * 2;
      const landCol = coord.col + dc * 2;
      if (!this.inBounds(landRow, landCol)) continue;
      const midPiece = board[coord.row + dr][coord.col + dc];
      if (!midPiece || midPiece.owner === userId) continue;
      if (board[landRow][landCol] !== null) continue;
      return true;
    }
    return false;
  }

  private hasSimpleMoveFromSquare(
    board: Board,
    coord: Coord,
    piece: CheckersPiece,
    playerOrder: [string, string],
  ): boolean {
    const forwardDir = this.forwardDirectionFor(playerOrder, piece.owner);
    for (const [dr, dc] of this.directionsFor(piece, forwardDir)) {
      const row = coord.row + dr;
      const col = coord.col + dc;
      if (!this.inBounds(row, col)) continue;
      if (board[row][col] === null) return true;
    }
    return false;
  }

  private hasAnyCaptureForPlayer(
    state: CheckersState,
    userId: string,
  ): boolean {
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = state.board[row][col];
        if (
          piece &&
          piece.owner === userId &&
          this.hasCaptureFromSquare(
            state.board,
            { row, col },
            userId,
            state.playerOrder,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private hasAnyLegalMoveForPlayer(
    state: CheckersState,
    userId: string,
  ): boolean {
    if (state.mustContinueFrom) {
      return this.hasCaptureFromSquare(
        state.board,
        state.mustContinueFrom,
        userId,
        state.playerOrder,
      );
    }
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = state.board[row][col];
        if (!piece || piece.owner !== userId) continue;
        const coord = { row, col };
        if (
          this.hasCaptureFromSquare(
            state.board,
            coord,
            userId,
            state.playerOrder,
          ) ||
          this.hasSimpleMoveFromSquare(
            state.board,
            coord,
            piece,
            state.playerOrder,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private extractMove(move: unknown): CheckersMove | null {
    if (typeof move !== 'object' || move === null) return null;
    const obj = move as Record<string, unknown>;
    const from = this.extractCoord(obj.from);
    const to = this.extractCoord(obj.to);
    if (!from || !to) return null;
    return { from, to };
  }

  private extractCoord(value: unknown): Coord | null {
    if (typeof value !== 'object' || value === null) return null;
    const obj = value as Record<string, unknown>;
    const row = obj.row;
    const col = obj.col;
    if (typeof row !== 'number' || typeof col !== 'number') return null;
    if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
    if (!this.inBounds(row, col)) return null;
    return { row, col };
  }
}
