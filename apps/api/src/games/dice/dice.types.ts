/** Dice per roll — each player rolls this many six-sided dice per attempt. */
export const DICE_PER_ROLL = 2;
export const DIE_FACES = 6;

/** First player to win this many (non-tied) rounds wins the match. */
export const ROUNDS_TO_WIN = 2;

/**
 * This many *consecutive* tied attempts end the match as a draw. The
 * counter increments on every tied attempt and resets to 0 the moment an
 * attempt produces a round winner — see
 * docs/decisions/ADR-025-dice-game-module.md, "Tie semantics".
 */
export const MAX_CONSECUTIVE_TIES = 3;

/** One player's roll of [DICE_PER_ROLL] dice, recorded for audit. */
export interface DiceRoll {
  userId: string;
  dice: [number, number];
  total: number;
}

/**
 * One completed *attempt*: both players have rolled and the totals were
 * compared. `round` is the 1-based round the attempt belongs to — a tied
 * attempt replays the same round, so several attempts can share a
 * `round`. `winnerUserId` is `null` for a tie.
 */
export interface DiceAttempt {
  round: number;
  /** Rolls in the order they happened (starter first). */
  rolls: [DiceRoll, DiceRoll];
  winnerUserId: string | null;
}

/**
 * Server-authoritative Dice state. Private to `DiceModule` — the platform
 * persists it opaquely in `Match.state`. Contains only values that have
 * already been rolled: no future roll, seed, or RNG state is ever stored
 * here (ADR-025).
 */
export interface DiceState {
  playerOrder: [string, string];
  /** The player who must roll next. Stale (but ignored) once finished. */
  currentTurn: string;
  /** 1-based number of the round currently being played. */
  round: number;
  /** Rounds won so far, aligned with `playerOrder`. */
  roundWins: [number, number];
  /** Consecutive tied attempts so far; reset by any decided attempt. */
  consecutiveTies: number;
  /** The starter's roll in the attempt in progress, once rolled. */
  pendingRoll: DiceRoll | null;
  /** Every completed attempt, oldest first — the auditable roll history. */
  attempts: DiceAttempt[];
  winnerUserId: string | null;
  isDraw: boolean;
}

/** The only legal move: `{ "action": "roll" }`. Carries no dice values. */
export interface DiceMove {
  action: 'roll';
}
