import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  GameModule,
  GameResult,
  MoveValidationResult,
} from '../contracts/game-module.interface.js';
import { DICE_RNG, type DiceRng } from './dice-rng.js';
import {
  DIE_FACES,
  MAX_CONSECUTIVE_TIES,
  ROUNDS_TO_WIN,
  type DiceAttempt,
  type DiceMove,
  type DiceRoll,
  type DiceState,
} from './dice.types.js';

/**
 * Server-authoritative Dice rules (best of three rounds, two dice per
 * roll, higher total wins the round). Rules, tie semantics, and the RNG
 * architecture are documented in
 * docs/decisions/ADR-025-dice-game-module.md.
 *
 * The only non-deterministic step is `applyMove`'s call into the injected
 * [DiceRng]. `MatchesService.submitCommand` calls `applyMove` exactly
 * once per accepted command, inside the row-locked transaction that also
 * persists the resulting state and the `MatchCommand` row — so a roll is
 * committed atomically with the command that caused it, and a replayed
 * `commandId` returns the stored command without ever reaching this
 * module again. Never trusts a client-supplied roll, winner, or turn: the
 * only accepted payload is `{ "action": "roll" }`.
 */
@Injectable()
export class DiceModule implements GameModule<DiceState, DiceMove> {
  readonly gameId = 'dice';
  readonly version = 1;
  readonly minPlayers = 2;
  readonly maxPlayers = 2;
  readonly supportsResignation = true;
  /** Agreed draws are meaningless in a pure-chance game (ADR-025). */
  readonly supportsDraws = false;

  constructor(@Inject(DICE_RNG) private readonly rng: DiceRng) {}

  createInitialState(playerUserIds: string[]): DiceState {
    if (playerUserIds.length !== 2) {
      throw new Error('Dice requires exactly 2 players');
    }
    const playerOrder: [string, string] = [playerUserIds[0], playerUserIds[1]];
    return {
      playerOrder,
      currentTurn: this.starterForRound(playerOrder, 1),
      round: 1,
      roundWins: [0, 0],
      consecutiveTies: 0,
      pendingRoll: null,
      attempts: [],
      winnerUserId: null,
      isDraw: false,
    };
  }

  currentTurnUserId(state: DiceState): string | null {
    if (this.isFinished(state)) return null;
    return state.currentTurn;
  }

  validateMove(
    state: DiceState,
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
    if (!this.isRollMove(move)) {
      return { valid: false, reason: 'That move is not valid' };
    }
    return { valid: true };
  }

  /**
   * `move` is intentionally not a parameter: the only legal move
   * (`{ "action": "roll" }`) carries no information — the outcome comes
   * solely from the injected RNG.
   */
  applyMove(state: DiceState, userId: string): DiceState {
    const roll = this.rollFor(userId);

    // First roll of the attempt: record it and hand the turn over.
    if (state.pendingRoll === null) {
      return {
        ...state,
        pendingRoll: roll,
        currentTurn: this.otherPlayer(state, userId),
      };
    }

    // Second roll: the attempt is complete — compare totals.
    const starterRoll = state.pendingRoll;
    const winnerUserId =
      starterRoll.total === roll.total
        ? null
        : starterRoll.total > roll.total
          ? starterRoll.userId
          : roll.userId;
    const attempt: DiceAttempt = {
      round: state.round,
      rolls: [starterRoll, roll],
      winnerUserId,
    };
    const attempts = [...state.attempts, attempt];

    if (winnerUserId === null) {
      // Tied attempt: the same round is replayed with the same starter.
      const consecutiveTies = state.consecutiveTies + 1;
      const isDraw = consecutiveTies >= MAX_CONSECUTIVE_TIES;
      return {
        ...state,
        attempts,
        consecutiveTies,
        pendingRoll: null,
        isDraw,
        currentTurn: this.starterForRound(state.playerOrder, state.round),
      };
    }

    const winnerIndex = state.playerOrder.indexOf(winnerUserId);
    const roundWins: [number, number] = [
      state.roundWins[0],
      state.roundWins[1],
    ];
    roundWins[winnerIndex] += 1;

    if (roundWins[winnerIndex] >= ROUNDS_TO_WIN) {
      return {
        ...state,
        attempts,
        roundWins,
        consecutiveTies: 0,
        pendingRoll: null,
        winnerUserId,
      };
    }

    // Round decided but the match goes on: next round, starter alternates.
    const nextRound = state.round + 1;
    return {
      ...state,
      attempts,
      roundWins,
      consecutiveTies: 0,
      pendingRoll: null,
      round: nextRound,
      currentTurn: this.starterForRound(state.playerOrder, nextRound),
    };
  }

  isFinished(state: DiceState): boolean {
    return state.winnerUserId !== null || state.isDraw;
  }

  getResult(state: DiceState): GameResult | null {
    if (!this.isFinished(state)) return null;
    return { winnerUserId: state.winnerUserId, isDraw: state.isDraw };
  }

  serializeState(state: DiceState): Prisma.JsonValue {
    return state as unknown as Prisma.JsonValue;
  }

  deserializeState(json: Prisma.JsonValue): DiceState {
    return json as unknown as DiceState;
  }

  /** Odd rounds start with seat 0, even rounds with seat 1. */
  private starterForRound(
    playerOrder: [string, string],
    round: number,
  ): string {
    return playerOrder[(round - 1) % 2];
  }

  private otherPlayer(state: DiceState, userId: string): string {
    return state.playerOrder[0] === userId
      ? state.playerOrder[1]
      : state.playerOrder[0];
  }

  /**
   * Accepts exactly `{ "action": "roll" }` — any other key (e.g. a
   * client-supplied `dice`/`total`) is rejected outright rather than
   * silently ignored, so a tampered payload is visible in the command log.
   */
  private isRollMove(move: unknown): move is DiceMove {
    if (typeof move !== 'object' || move === null || Array.isArray(move)) {
      return false;
    }
    const keys = Object.keys(move);
    return (
      keys.length === 1 &&
      keys[0] === 'action' &&
      (move as { action: unknown }).action === 'roll'
    );
  }

  private rollFor(userId: string): DiceRoll {
    const first = this.rollDie();
    const second = this.rollDie();
    return { userId, dice: [first, second], total: first + second };
  }

  /** Guards against a faulty injected RNG ever corrupting stored state. */
  private rollDie(): number {
    const value = this.rng.rollDie();
    if (!Number.isInteger(value) || value < 1 || value > DIE_FACES) {
      throw new Error(`RNG returned an invalid die value: ${String(value)}`);
    }
    return value;
  }
}
