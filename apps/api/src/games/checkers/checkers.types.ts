/**
 * Checkers' authoritative state. Private to this module — the platform
 * persists it opaquely in `Match.state` (see
 * `GameModule.serializeState`/`deserializeState`) and never inspects it.
 *
 * Standard American/English checkers on an 8x8 board; only dark squares
 * (`(row + col) % 2 === 1`) are ever occupied. `board[row][col]` holds the
 * piece there, or `null`. `playerOrder[0]` starts on rows 0-2 and moves
 * toward increasing row ("forward direction" +1); `playerOrder[1]` starts
 * on rows 5-7 and moves toward decreasing row (forward direction -1).
 * Kings move the same single-square distance as a man, just in either
 * direction — not "flying kings".
 *
 * Turn state is explicit (`currentTurn`), not derived from a move count —
 * unlike Tic-Tac-Toe, a turn here can span several accepted commands (one
 * per jump in a multi-jump sequence), tracked via `mustContinueFrom`. See
 * docs/decisions/ADR-022-checkers-game-module.md for the exact rule
 * choices (promotion ends the turn immediately; the 40-move no-progress
 * draw rule).
 */
export interface CheckersPiece {
  owner: string;
  king: boolean;
}

export interface Coord {
  row: number;
  col: number;
}

export interface CheckersState {
  board: (CheckersPiece | null)[][];
  playerOrder: [string, string];
  currentTurn: string;
  /**
   * Set to the board square of a piece that just captured and has at
   * least one further capture available — the only piece allowed to
   * move next, and only via another jump. `null` when no multi-jump
   * continuation is pending (the normal case).
   */
  mustContinueFrom: Coord | null;
  /**
   * Half-moves (single accepted commands) since the last capture or man
   * (non-king) move — the only irreversible kinds of progress. Reaching
   * `DRAW_NO_PROGRESS_LIMIT` ends the match in a draw, so two kings
   * cannot shuffle forever. See ADR-022.
   */
  movesSinceProgress: number;
  winnerUserId: string | null;
  isDraw: boolean;
}

export interface CheckersMove {
  from: Coord;
  to: Coord;
}

export const BOARD_SIZE = 8;

/** See ADR-022 — the explicit, documented draw rule this module enforces. */
export const DRAW_NO_PROGRESS_LIMIT = 40;
