/**
 * Tic-Tac-Toe's authoritative state. Private to this module — the
 * platform persists it opaquely in `Match.state` (see
 * `GameModule.serializeState`/`deserializeState`) and never inspects it.
 *
 * `board[i]` is the userId occupying cell `i` (0-8, row-major), or `null`.
 * `playerOrder[0]` plays X (moves first); `playerOrder[1]` plays O.
 */
export interface TicTacToeState {
  board: (string | null)[];
  playerOrder: [string, string];
  moveCount: number;
  winnerUserId: string | null;
  isDraw: boolean;
}

export interface TicTacToeMove {
  cell: number;
}

export const BOARD_SIZE = 9;

export const WIN_LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];
