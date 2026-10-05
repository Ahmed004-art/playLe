import type { Prisma } from '@prisma/client';

/** Returned by `GameModule.validateMove` — never throws for an invalid move. */
export interface MoveValidationResult {
  valid: boolean;
  reason?: string;
}

/** Returned by `GameModule.getResult` once `isFinished` is true. */
export interface GameResult {
  winnerUserId: string | null;
  isDraw: boolean;
}

/**
 * The contract every game implements. The generic match/command pipeline
 * (`MatchesService`) only ever talks to this interface — it never branches
 * on a specific `gameId`. See docs/decisions/ADR-015-game-module-architecture.md.
 *
 * `TState` is a plain, JSON-serializable object private to the game
 * module; the platform persists it opaquely in `Match.state` and never
 * inspects its shape.
 */
export interface GameModule<TState = unknown, TMove = unknown> {
  /** Must match a `Game.id` row in the catalog. */
  readonly gameId: string;
  readonly version: number;
  readonly minPlayers: number;
  readonly maxPlayers: number;

  createInitialState(playerUserIds: string[]): TState;

  /** The user who may submit the next move, or `null` once finished. */
  currentTurnUserId(state: TState): string | null;

  /**
   * Must handle a malformed/unknown `move` payload gracefully (return
   * `{ valid: false }`), never throw — a bad client payload is an
   * ordinary rejection, not a server error.
   */
  validateMove(
    state: TState,
    userId: string,
    move: unknown,
  ): MoveValidationResult;

  /** Only ever called after `validateMove` returned `valid: true`. */
  applyMove(state: TState, userId: string, move: TMove): TState;

  isFinished(state: TState): boolean;

  /** `null` until `isFinished(state)` is true. */
  getResult(state: TState): GameResult | null;

  serializeState(state: TState): Prisma.JsonValue;
  deserializeState(json: Prisma.JsonValue): TState;
}

/** DI token for the multi-provider array of registered `GameModule`s. */
export const GAME_MODULES = Symbol('GAME_MODULES');
