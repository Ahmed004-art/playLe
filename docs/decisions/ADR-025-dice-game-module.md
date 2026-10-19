# ADR-025: Dice Game Module

## Status
Accepted — Phase 10 (implemented; seeded **disabled**)

## Context
Phase 10 adds Dice as the platform's third game, through the existing
generic `GameModule` contract ([ADR-015](ADR-015-game-module-architecture.md))
with no platform change, as Checkers did ([ADR-022](ADR-022-checkers-game-module.md)).
Dice differs from the two existing games in one fundamental way: **the
outcome of a move depends on randomness, not on player choice**. That
raises questions the board games never did — where randomness comes from,
whether a retried command can re-roll, what a tie means, and what honest
claims can be made about fairness. It is also a pure game of chance,
which changes the legal and payment-provider position of any real-money
launch (see "Implementing versus launching" below).

A pre-implementation audit of the real code confirmed the seams this
design relies on:

- `GameModule.applyMove` is called in exactly one place —
  `MatchesService.submitCommand` — inside the row-locked transaction that
  also persists the new state and the `MatchCommand` row. Nothing replays
  moves, so a non-deterministic `applyMove` is architecturally safe.
- `SettlementService.settle()` never calls a game module; it reads only
  `Match.status`/`winnerUserId`/`resultIsDraw` ([ADR-017](ADR-017-deterministic-settlement.md),
  [ADR-024](ADR-024-match-lifecycle-integrity.md)). A draw already settles
  as a full refund with no fee.
- Resignation, turn timeouts, and the capability flags
  (`supportsResignation`/`supportsDraws`) are already generic
  ([ADR-024](ADR-024-match-lifecycle-integrity.md)).

## Decision

### Rules
- Two players per match. Each **attempt** has both players roll two
  six-sided dice (the **total** is the sum, 2-12); the starter rolls
  first, then the other player.
- The higher total wins the **round**. The first player to win **two
  rounds** wins the match (a match therefore has at most three decided
  rounds).
- The **starter alternates between rounds**: round 1 starts with seat 0
  (the challenger, or the first player of a matchmaking pair), round 2
  with seat 1, round 3 with seat 0. The starter of round *r* is
  `playerOrder[(r - 1) % 2]`.
- A **tied attempt** does not count: the same round is replayed, with the
  **same starter** (a replay is the same round, not a new one).
- **Draw rule:** three *consecutive* tied attempts end the match as a
  draw.

### Tie semantics (exact)
`consecutiveTies` is the number of tied attempts since the most recent
decided attempt (or since the match began).

- A tied attempt increments it by 1.
- **Any attempt that decides a round resets it to 0**, whether or not that
  round also ends the match.
- The match is a draw **the moment it reaches 3** — i.e. on the third tied
  attempt in a row.
- Two ties followed by a decided attempt is not a draw; the counter resets
  and a later tie starts again from 1. Ties separated by a decided round
  are therefore never "consecutive".
- Consequently a match is bounded: at most three decided rounds, each
  preceded by at most two ties = 9 attempts = **18 rolls**. The unit test
  `always terminates a real match within the proven bound` checks this
  against the production RNG. The bound matters financially: a staked
  match can never stay `ACTIVE` with funds held indefinitely (the same
  reasoning as Checkers' 40-move rule in ADR-022).

A draw is reported through the unchanged binary `GameResult`
(`{ winnerUserId: null, isDraw: true }`) and settles through the existing
`DRAW` path: both stakes refunded, no platform fee.

### State machine
`DiceState` (private to the module, persisted opaquely in `Match.state`):

| Field | Meaning |
|---|---|
| `playerOrder` | `[seat0UserId, seat1UserId]` |
| `currentTurn` | the player who must roll next (ignored once finished) |
| `round` | 1-based round in play |
| `roundWins` | rounds won, aligned with `playerOrder` |
| `consecutiveTies` | see "Tie semantics" |
| `pendingRoll` | the starter's roll in the attempt in progress, else `null` |
| `attempts` | every completed attempt, oldest first (the roll history) |
| `winnerUserId` / `isDraw` | terminal result, else `null` / `false` |

Transitions, per accepted `roll` command by `currentTurn`:

1. **No `pendingRoll`** (the starter is rolling): record the roll as
   `pendingRoll`; `currentTurn` becomes the other player. Nothing is
   scored.
2. **`pendingRoll` present** (the responder is rolling): the attempt is
   complete; append it to `attempts`, then
   - *totals equal* — `consecutiveTies += 1`; `pendingRoll = null`;
     `currentTurn` = the same round's starter; if `consecutiveTies` is now
     3, set `isDraw`.
   - *a total is higher* — that player's `roundWins += 1`;
     `consecutiveTies = 0`; `pendingRoll = null`; if their `roundWins`
     reached 2 set `winnerUserId`, otherwise `round += 1` and `currentTurn`
     = the new round's starter.

The only legal move is exactly `{ "action": "roll" }`. `validateMove`
rejects (never throws on) anything else — including any payload that also
carries `dice`, `total`, `winnerUserId`, or any other key — so a tampered
payload is rejected visibly and recorded in the command log rather than
silently ignored. Validation never consumes randomness.

`supportsResignation = true` (a player may concede; handled generically,
`terminationReason: RESIGNATION`). `supportsDraws = false`: agreed draws
add nothing to a pure-chance game, and the generic pipeline rejects
`DRAW_OFFER`/`DRAW_ACCEPT`/`DRAW_REJECT` with "This game does not support
draw offers" (ADR-024), which the mobile action bar also hides.

### Turn timer
`Game.turnTimeoutSeconds = 30`, set explicitly in the Dice seed migration
(the Phase 9 backfill only covered the two earlier games, and a roll is a
single tap, so 30 seconds rather than the board games' 60). It is
refreshed on every accepted roll, so the responder gets a fresh 30 seconds
after the starter rolls. On expiry the current turn-holder forfeits
(`TURN_TIMEOUT`), under the same row lock as a roll
([ADR-024](ADR-024-match-lifecycle-integrity.md)); no change to the sweep
was needed.

### Randomness architecture
- All rolls are generated **on the server** by an injected `DiceRng`
  (`DICE_RNG` token; `apps/api/src/games/dice/dice-rng.ts`). The production
  binding, `CryptoDiceRng`, calls `crypto.randomInt(1, 7)`: the operating
  system's CSPRNG with rejection sampling, so every face is uniformly
  likely (no modulo bias).
- The mobile client **never supplies, predicts, or influences** a roll,
  and the roll command carries no dice values. The tumble animation is
  cosmetic only.
- The RNG is drawn **inside `applyMove`, only after `validateMove`
  succeeds**. Dice are rolled when a command is applied; no future roll,
  seed, or RNG state is ever generated early or stored in `Match.state`.
- Tests bind a scripted RNG through the same DI token (unit tests
  construct `DiceModule` with it directly; the e2e suite uses
  `overrideProvider(DICE_RNG)`), so no test depends on real randomness.
- `DiceModule` validates every value the RNG returns (integer, 1-6) and
  throws rather than store anything else, so a faulty injected RNG can
  never corrupt stored state.

### Idempotency, replay, and concurrent duplicates
The roll rides the existing `MatchesService.submitCommand` guarantees:

- A **replayed `commandId`** is answered from the stored `MatchCommand`
  before any module code runs — it can never produce another roll.
- The state update, the roll's dice, and the `MatchCommand` insert are one
  transaction. If any step fails, the whole transaction — including the
  dice — rolls back; a roll is never persisted without its command.
- **Concurrent duplicates** serialize on the match row lock. The case
  specific to Dice: after a round is decided, the player who *responded*
  is also the *next round's starter*, so a duplicate of their responding
  command can be a **legal roll a second time**. If it were applied, its
  `MatchCommand` insert would collide with the first request's
  `(matchId, commandId)` key (`P2002`), which aborts the transaction and
  discards the phantom roll; `submitCommand` then returns the stored
  command. The e2e test `never double-rolls for concurrent duplicates of
  the same command` exercises exactly this shape (three simultaneous
  duplicates, repeated, with spare scripted dice that a phantom roll would
  consume) and asserts a single roll, a single command row, and no
  persisted phantom roll.
- A roll racing the timeout sweep serializes on the same lock: exactly one
  of "roll accepted" or "turn timed out" wins (e2e: `serializes a roll
  racing the timeout sweep into exactly one outcome`).

### Roll history and what is exposed
Every completed attempt is kept in `attempts` (both players' dice and
totals, the round, and the attempt's winner), and every command is also
recorded in `match_commands`. This is the auditable history; the admin
match detail page already renders `Match.state` as JSON, so no admin
change was required. The only roll visible before an attempt completes is
`pendingRoll` — a value that has *already been rolled* and is shown to
both players by design. There is no secret to leak: future rolls do not
exist yet, and no seed or RNG state is stored.

### Financial integration (no change)
Dice reuses, unchanged: equal-stake confirmation, the rolling-window
responsible-gaming checks and self-exclusion
([ADR-021](ADR-021-eligibility-and-responsible-gaming.md),
[ADR-023](ADR-023-rolling-window-responsible-gaming.md)), wallets, the
immutable ledger, and `SettlementService` with its `floor(pool × 10 / 100)`
fee. A win pays the winner pool minus the fee; a draw refunds both stakes
with no fee. Nothing in `src/settlement`, `src/ledger`, `src/eligibility`,
`MatchesService`, `GameModule`, `GameResult`, or the Prisma schema
changed. The e2e suite proves staked win, staked draw, staked resignation,
staked turn-timeout, and self-exclusion on the Dice path.

### Implementing versus launching
**Implementing Dice is not authorization to launch it.** Dice is a pure
game of chance, unlike Tic-Tac-Toe and Checkers, so:

- Whether real-money games of chance are lawful for PlayLe's intended
  operation, and whether the payment provider's merchant terms permit
  them, are **owner/legal questions this phase neither answers nor
  assumes** — see `docs/development/OUTSTANDING_WORK.md` (items 3 and 20).
- The seed migration therefore inserts the catalog row with
  `enabled = false`. A disabled game is absent from the catalog and cannot
  be challenged or matched (`GamesService.findEnabledById`). Enabling it
  is a deliberate catalog change that this phase adds no tooling for. The
  e2e suite enables the row only for its own duration and restores it, and
  has a test asserting the seeded default.
- `REAL_MONEY_GAMING_ENABLED` and `ELIGIBILITY_POLICY_CONFIGURED` keep
  their defaults and independence ([ADR-021](ADR-021-eligibility-and-responsible-gaming.md));
  nothing about Dice changes either, and free-play Dice works without
  them.

### Fairness limitations (stated plainly)
Dice outcomes come from a conventional server-side CSPRNG. **This is not
"provably fair".** There is no commit-reveal (or any other verifiable
randomness) protocol, so a player cannot independently verify that rolls
were drawn honestly — they must trust PlayLe. What the design does give:
a uniform, unbiased, server-only source; no client influence; an atomic,
idempotent roll; and a complete stored history for after-the-fact audit
and disputes. Neither the UI nor any marketing may describe Dice as
"provably fair". A commit-reveal scheme (e.g. committing to a per-match
seed hash at creation and revealing it at the end) would be a separate
design and phase, and would need its own ADR.

### Mobile and admin
`apps/mobile/lib/features/dice/`: `DiceScreen` (a renderer of
server-pushed state), `DiceFace`/`TumblingDie`/`DiceRollRow`/`RoundPips`
widgets, and `DiceBoardState` (a read-only parse of `Match.state`),
reusing the shared match chrome (status bar, stake bar, resign dialog,
result and financial banners). The tumble animation cycles faces in a
fixed order — never a local random draw — and always settles on the
server's value; it is skipped entirely under reduced-motion settings. All
visible results (dice, totals, round winners, the outcome) derive from the
server state. Automated widget tests verify behavior, not visual quality;
see `docs/development/OUTSTANDING_WORK.md` item 22 for the remaining
on-device visual verification.

## Alternatives Considered
- **Unbounded tie replays until decided** — rejected; a staked match could
  stay `ACTIVE` indefinitely. The three-consecutive-ties draw bounds it.
- **A single roll per player (no rounds)** — rejected by the approved
  rules; best-of-three gives a more engaging match with the same
  platform footprint.
- **Counting all ties in a match (not just consecutive)** — rejected as the
  approved rule is explicitly "consecutive"; a decided round resets the
  counter.
- **Auto-rolling on the player's behalf at timeout** — rejected; it would
  change the generic turn-timeout path for one game, and the approved
  behavior is forfeit-on-timeout like every other game.
- **Extending `GameModule.applyMove` with a context/RNG parameter** —
  rejected; constructor injection of the RNG needs no interface change.
- **Pre-generating all rolls at match creation** — rejected; it would put
  future outcomes into `Match.state`, which is sent to both clients.
- **Commit-reveal provable fairness** — out of scope for Phase 10; see
  "Fairness limitations".

## Consequences
- Dice is registered by one `GamesModule` provider entry, one seed
  migration, and one mobile dispatch case — the same footprint as
  Checkers — plus the injectable RNG binding. No platform code changed.
- Any future game needing randomness can follow the same pattern: an
  injected source, drawn only inside `applyMove`, never stored.
- Because `applyMove` is non-deterministic for Dice, nothing may ever
  *replay* moves to rebuild state (event-sourcing-style recovery). None
  does today; this ADR records the constraint.
- Enabling Dice for real money is blocked on owner decisions that no code
  change can resolve.
