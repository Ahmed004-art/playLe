import { CryptoDiceRng, type DiceRng } from './dice-rng.js';
import { DiceModule } from './dice.module-impl.js';
import {
  MAX_CONSECUTIVE_TIES,
  ROUNDS_TO_WIN,
  type DiceState,
} from './dice.types.js';

const P1 = 'player-1';
const P2 = 'player-2';

/** A deterministic, scripted RNG — throws if a test under-scripts it. */
class ScriptedRng implements DiceRng {
  private queue: number[] = [];
  calls = 0;

  push(...dice: number[]): void {
    this.queue.push(...dice);
  }

  get remaining(): number {
    return this.queue.length;
  }

  rollDie(): number {
    this.calls++;
    const value = this.queue.shift();
    if (value === undefined) throw new Error('ScriptedRng exhausted');
    return value;
  }
}

describe('DiceModule', () => {
  let rng: ScriptedRng;
  let module: DiceModule;
  let state: DiceState;

  beforeEach(() => {
    rng = new ScriptedRng();
    module = new DiceModule(rng);
    state = module.createInitialState([P1, P2]);
  });

  /** One player's roll: scripts the two dice, then applies the move. */
  function roll(s: DiceState, dice: [number, number]): DiceState {
    const userId = module.currentTurnUserId(s);
    if (userId === null) throw new Error('match already finished');
    expect(module.validateMove(s, userId, { action: 'roll' })).toEqual({
      valid: true,
    });
    rng.push(...dice);
    return module.applyMove(s, userId);
  }

  /** A full attempt: the starter rolls, then the other player rolls. */
  function attempt(
    s: DiceState,
    first: [number, number],
    second: [number, number],
  ): DiceState {
    return roll(roll(s, first), second);
  }

  describe('identity and capabilities', () => {
    it('is the dice game for exactly two players', () => {
      expect(module.gameId).toBe('dice');
      expect(module.version).toBe(1);
      expect(module.minPlayers).toBe(2);
      expect(module.maxPlayers).toBe(2);
    });

    it('supports resignation but not agreed draws', () => {
      expect(module.supportsResignation).toBe(true);
      expect(module.supportsDraws).toBe(false);
    });

    it('uses the approved rule constants', () => {
      expect(ROUNDS_TO_WIN).toBe(2);
      expect(MAX_CONSECUTIVE_TIES).toBe(3);
    });
  });

  describe('createInitialState', () => {
    it('starts round 1 with seat 0 to roll and an empty history', () => {
      expect(state).toEqual({
        playerOrder: [P1, P2],
        currentTurn: P1,
        round: 1,
        roundWins: [0, 0],
        consecutiveTies: 0,
        pendingRoll: null,
        attempts: [],
        winnerUserId: null,
        isDraw: false,
      });
      expect(rng.calls).toBe(0);
    });

    it('rejects anything other than exactly two players', () => {
      expect(() => module.createInitialState([P1])).toThrow();
      expect(() => module.createInitialState([P1, P2, 'p3'])).toThrow();
      expect(() => module.createInitialState([])).toThrow();
    });

    it('is not finished and has no result', () => {
      expect(module.isFinished(state)).toBe(false);
      expect(module.getResult(state)).toBeNull();
      expect(module.currentTurnUserId(state)).toBe(P1);
    });
  });

  describe('validateMove', () => {
    it('accepts exactly { action: "roll" } from the player to roll', () => {
      expect(module.validateMove(state, P1, { action: 'roll' })).toEqual({
        valid: true,
      });
    });

    it('rejects a roll out of turn', () => {
      const result = module.validateMove(state, P2, { action: 'roll' });
      expect(result).toEqual({ valid: false, reason: 'It is not your turn' });
    });

    it('rejects a non-participant', () => {
      const result = module.validateMove(state, 'stranger', { action: 'roll' });
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/not a participant/);
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a string', 'roll'],
      ['a number', 6],
      ['an array', ['roll']],
      ['an empty object', {}],
      ['a wrong action', { action: 'ROLL' }],
      ['an unknown action', { action: 'reroll' }],
      ['a non-string action', { action: 1 }],
      ['a missing action key', { roll: true }],
    ])('rejects a malformed payload (%s) without throwing', (_label, move) => {
      expect(module.validateMove(state, P1, move)).toEqual({
        valid: false,
        reason: 'That move is not valid',
      });
    });

    it.each([
      ['dice', { action: 'roll', dice: [6, 6] }],
      ['total', { action: 'roll', total: 12 }],
      ['winner', { action: 'roll', winnerUserId: P1 }],
      ['result', { action: 'roll', result: 'WIN' }],
    ])('rejects a payload that tries to supply %s', (_label, move) => {
      expect(module.validateMove(state, P1, move).valid).toBe(false);
    });

    it('does not consume randomness while validating', () => {
      module.validateMove(state, P1, { action: 'roll' });
      module.validateMove(state, P1, { action: 'nope' });
      expect(rng.calls).toBe(0);
    });

    it('rejects every move once the match is finished', () => {
      let s = attempt(state, [6, 6], [1, 1]);
      s = attempt(s, [1, 1], [6, 6]);
      expect(module.isFinished(s)).toBe(true);
      expect(module.validateMove(s, P1, { action: 'roll' })).toEqual({
        valid: false,
        reason: 'This match has already ended',
      });
    });
  });

  describe('a single attempt', () => {
    it('records the first roll and passes the turn without finishing', () => {
      const next = roll(state, [3, 4]);
      expect(next.pendingRoll).toEqual({
        userId: P1,
        dice: [3, 4],
        total: 7,
      });
      expect(next.currentTurn).toBe(P2);
      expect(next.attempts).toEqual([]);
      expect(next.roundWins).toEqual([0, 0]);
      expect(module.isFinished(next)).toBe(false);
      expect(module.currentTurnUserId(next)).toBe(P2);
    });

    it('draws exactly two dice per roll from the injected RNG', () => {
      roll(state, [2, 5]);
      expect(rng.calls).toBe(2);
      expect(rng.remaining).toBe(0);
    });

    it('awards the round to the higher total and records both rolls', () => {
      const next = attempt(state, [3, 4], [2, 6]);
      expect(next.attempts).toEqual([
        {
          round: 1,
          rolls: [
            { userId: P1, dice: [3, 4], total: 7 },
            { userId: P2, dice: [2, 6], total: 8 },
          ],
          winnerUserId: P2,
        },
      ]);
      expect(next.roundWins).toEqual([0, 1]);
      expect(next.pendingRoll).toBeNull();
      expect(next.round).toBe(2);
    });

    it('awards the round to the starter when the starter rolls higher', () => {
      const next = attempt(state, [6, 5], [1, 2]);
      expect(next.roundWins).toEqual([1, 0]);
      expect(next.attempts[0].winnerUserId).toBe(P1);
    });

    it('compares totals, not individual dice', () => {
      // 6+1 = 7 beats 3+3 = 6 even though 6 > 3 on one die either way.
      const next = attempt(state, [6, 1], [3, 3]);
      expect(next.roundWins).toEqual([1, 0]);
    });

    it('does not mutate the input state', () => {
      const before = JSON.stringify(state);
      roll(state, [1, 2]);
      expect(JSON.stringify(state)).toBe(before);
    });
  });

  describe('alternating starters', () => {
    it('starts round 2 with the other player', () => {
      const afterRound1 = attempt(state, [6, 6], [1, 1]);
      expect(afterRound1.round).toBe(2);
      expect(afterRound1.currentTurn).toBe(P2);
    });

    it('starts round 3 with seat 0 again', () => {
      let s = attempt(state, [6, 6], [1, 1]); // P1 wins round 1
      s = attempt(s, [6, 6], [1, 1]); // P2 starts round 2 and wins it
      expect(s.roundWins).toEqual([1, 1]);
      expect(s.round).toBe(3);
      expect(s.currentTurn).toBe(P1);
    });

    it('records which player started each attempt first in its rolls', () => {
      let s = attempt(state, [6, 6], [1, 1]);
      s = attempt(s, [6, 6], [1, 1]);
      expect(s.attempts[0].rolls[0].userId).toBe(P1);
      expect(s.attempts[1].rolls[0].userId).toBe(P2);
    });
  });

  describe('tied attempts', () => {
    it('replays the same round with the same starter and no score', () => {
      const next = attempt(state, [3, 4], [2, 5]); // 7 vs 7
      expect(next.attempts).toHaveLength(1);
      expect(next.attempts[0].winnerUserId).toBeNull();
      expect(next.roundWins).toEqual([0, 0]);
      expect(next.round).toBe(1);
      expect(next.consecutiveTies).toBe(1);
      expect(next.currentTurn).toBe(P1);
      expect(next.pendingRoll).toBeNull();
      expect(module.isFinished(next)).toBe(false);
    });

    it('keeps the starter of the replayed round in round 2 too', () => {
      let s = attempt(state, [6, 6], [1, 1]); // P1 wins round 1; P2 starts round 2
      s = attempt(s, [4, 4], [4, 4]); // tie
      expect(s.round).toBe(2);
      expect(s.currentTurn).toBe(P2);
    });

    it('ends in a draw on the third consecutive tie', () => {
      let s = attempt(state, [3, 3], [3, 3]);
      expect(s.consecutiveTies).toBe(1);
      expect(module.isFinished(s)).toBe(false);
      s = attempt(s, [4, 4], [4, 4]);
      expect(s.consecutiveTies).toBe(2);
      expect(module.isFinished(s)).toBe(false);
      s = attempt(s, [5, 5], [5, 5]);
      expect(s.consecutiveTies).toBe(3);
      expect(s.isDraw).toBe(true);
      expect(s.winnerUserId).toBeNull();
      expect(module.isFinished(s)).toBe(true);
      expect(module.getResult(s)).toEqual({ winnerUserId: null, isDraw: true });
      expect(module.currentTurnUserId(s)).toBeNull();
      expect(s.attempts).toHaveLength(3);
    });

    it('resets the tie counter when an attempt is decided', () => {
      let s = attempt(state, [3, 3], [3, 3]); // tie 1
      s = attempt(s, [3, 3], [3, 3]); // tie 2
      s = attempt(s, [6, 6], [1, 1]); // decided: counter resets
      expect(s.consecutiveTies).toBe(0);
      expect(s.roundWins).toEqual([1, 0]);
      expect(module.isFinished(s)).toBe(false);
    });

    it('does not draw on non-consecutive ties across rounds', () => {
      let s = attempt(state, [3, 3], [3, 3]); // tie 1
      s = attempt(s, [3, 3], [3, 3]); // tie 2
      s = attempt(s, [6, 6], [1, 1]); // P1 wins round 1
      s = attempt(s, [3, 3], [3, 3]); // tie 1 again (round 2)
      s = attempt(s, [3, 3], [3, 3]); // tie 2
      expect(module.isFinished(s)).toBe(false);
      expect(s.consecutiveTies).toBe(2);
      s = attempt(s, [1, 1], [6, 6]); // P1 (responder) wins round 2
      expect(s.winnerUserId).toBe(P1);
      expect(s.isDraw).toBe(false);
    });

    it('lets a decided attempt after two ties still win the match', () => {
      let s = attempt(state, [6, 6], [1, 1]); // P1 leads 1-0, P2 starts
      s = attempt(s, [2, 2], [2, 2]);
      s = attempt(s, [2, 2], [2, 2]);
      s = attempt(s, [1, 1], [6, 6]); // P1 responds with higher total
      expect(s.winnerUserId).toBe(P1);
      expect(s.consecutiveTies).toBe(0);
    });
  });

  describe('winning the match', () => {
    it('ends when a player wins two rounds', () => {
      let s = attempt(state, [6, 6], [1, 1]); // P1
      s = attempt(s, [1, 1], [6, 6]); // P2 starts, P1 responds higher
      expect(s.roundWins).toEqual([2, 0]);
      expect(s.winnerUserId).toBe(P1);
      expect(s.isDraw).toBe(false);
      expect(module.isFinished(s)).toBe(true);
      expect(module.getResult(s)).toEqual({ winnerUserId: P1, isDraw: false });
      expect(module.currentTurnUserId(s)).toBeNull();
    });

    it('goes to a deciding third round at one win each', () => {
      let s = attempt(state, [6, 6], [1, 1]); // P1 wins round 1
      s = attempt(s, [6, 6], [1, 1]); // P2 starts and wins round 2
      expect(module.isFinished(s)).toBe(false);
      s = attempt(s, [1, 1], [6, 6]); // round 3: P1 starts, P2 wins
      expect(s.roundWins).toEqual([1, 2]);
      expect(s.winnerUserId).toBe(P2);
      expect(module.getResult(s)).toEqual({ winnerUserId: P2, isDraw: false });
    });

    it('never needs more than three decided rounds', () => {
      let s = attempt(state, [6, 6], [1, 1]);
      s = attempt(s, [6, 6], [1, 1]);
      s = attempt(s, [6, 6], [1, 1]);
      expect(module.isFinished(s)).toBe(true);
      expect(s.attempts.filter((a) => a.winnerUserId !== null)).toHaveLength(3);
    });
  });

  describe('RNG guarantees', () => {
    it.each([0, 7, -1, 3.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'refuses an out-of-range die value (%s) instead of storing it',
      (bad) => {
        rng.push(bad, 3);
        expect(() => module.applyMove(state, P1)).toThrow(/invalid die value/);
      },
    );

    it('only ever stores dice that the RNG produced', () => {
      const s = attempt(state, [2, 5], [6, 1]);
      const dice = s.attempts[0].rolls.flatMap((r) => r.dice);
      expect(dice).toEqual([2, 5, 6, 1]);
      expect(rng.calls).toBe(4);
    });

    it('stores no seed, RNG state, or future roll', () => {
      const s = roll(state, [3, 4]);
      expect(Object.keys(s).sort()).toEqual(
        [
          'attempts',
          'consecutiveTies',
          'currentTurn',
          'isDraw',
          'pendingRoll',
          'playerOrder',
          'round',
          'roundWins',
          'winnerUserId',
        ].sort(),
      );
    });
  });

  describe('CryptoDiceRng', () => {
    it('only produces integers 1 through 6 and eventually every face', () => {
      const crypto = new CryptoDiceRng();
      const seen = new Set<number>();
      for (let i = 0; i < 6000; i++) {
        const value = crypto.rollDie();
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(1);
        expect(value).toBeLessThanOrEqual(6);
        seen.add(value);
      }
      expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('always terminates a real match within the proven bound', () => {
      // Worst case: three decided rounds, each preceded by two ties
      // = 9 attempts = 18 rolls. Never more, regardless of the dice.
      const real = new DiceModule(new CryptoDiceRng());
      for (let match = 0; match < 500; match++) {
        let s = real.createInitialState([P1, P2]);
        let rolls = 0;
        while (!real.isFinished(s)) {
          const userId = real.currentTurnUserId(s) as string;
          s = real.applyMove(s, userId);
          rolls++;
          expect(rolls).toBeLessThanOrEqual(18);
        }
      }
    });
  });

  describe('serialization', () => {
    it('round-trips through JSON unchanged, mid-attempt and finished', () => {
      const midAttempt = roll(state, [3, 4]);
      expect(
        module.deserializeState(module.serializeState(midAttempt)),
      ).toEqual(midAttempt);
      expect(
        module.deserializeState(
          JSON.parse(JSON.stringify(module.serializeState(midAttempt))),
        ),
      ).toEqual(midAttempt);

      let finished = attempt(state, [6, 6], [1, 1]);
      finished = attempt(finished, [1, 1], [6, 6]);
      expect(
        module.deserializeState(
          JSON.parse(JSON.stringify(module.serializeState(finished))),
        ),
      ).toEqual(finished);
    });
  });
});
