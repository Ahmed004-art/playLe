import { randomInt } from 'node:crypto';
import { DIE_FACES } from './dice.types.js';

/** DI token for the injectable Dice random source. */
export const DICE_RNG = Symbol('DICE_RNG');

/**
 * The only source of randomness `DiceModule` uses. Injectable so unit and
 * integration tests can supply a scripted, deterministic sequence; the
 * production binding is [CryptoDiceRng].
 */
export interface DiceRng {
  /** One fair die roll: an integer in `1..DIE_FACES`, inclusive. */
  rollDie(): number;
}

/**
 * Production RNG: `crypto.randomInt` draws from the operating system's
 * CSPRNG and applies rejection sampling, so every face is uniformly
 * likely (no modulo bias). Server-side only — a client never supplies or
 * influences a roll. This is a conventional CSPRNG, not a commit-reveal
 * protocol: outcomes are not independently verifiable by players (see
 * ADR-025, "Fairness limitations").
 */
export class CryptoDiceRng implements DiceRng {
  rollDie(): number {
    return randomInt(1, DIE_FACES + 1);
  }
}
