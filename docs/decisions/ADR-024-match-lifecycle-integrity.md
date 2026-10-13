# ADR-024: Match Lifecycle Integrity — Duplicate-Match Prevention, Turn Timers, Resignation/Draw Offers, Terminal-Outcome Semantics

## Status
Accepted — Phase 9

## Context
Phase 7's audit surfaced four related gaps, tracked as outstanding-work
items 13-17: no turn/move timer, matchmaking's duplicate-match check
ignoring `WAITING`, a binary `GameResult` with no reason, and no resign/
draw-offer command type. Phase 9's spec requires closing these for real,
while preserving every financial/eligibility guarantee from Phases 3-8
(the immutable ledger, exactly-once settlement, Phase 8's rolling-window
checks, self-exclusion with no lift path) and without touching
`SettlementService`'s settlement math.

A pre-implementation audit (two dedicated research passes over the real
code, not assumed from prior reports) confirmed the key fact this ADR's
design leans on: `SettlementService.settle()` never calls into a
`GameModule` at all — it derives a win/draw/cancellation purely from
`Match.status`/`winnerUserId`/`resultIsDraw` (see
[ADR-017](ADR-017-deterministic-settlement.md)). The disconnect-
abandonment path already proves this pattern: it writes those fields
directly, bypassing `GameModule.getResult()` entirely, and settlement
handles it exactly like a game-rules outcome. Every decision below
reuses that same seam rather than inventing a new one.

## Decisions

### 1. Duplicate-match prevention: advisory locks, not a new consistency mechanism

**The "already in a match" check now includes `WAITING`/`READY`, not
just `ACTIVE`** (closes item 14) — in both `MatchmakingService.join` and
(new) `ChallengesService.create`. This is the cheap, friendly, *advisory*
check — fast rejection for the common case, not the correctness
mechanism.

**The authoritative mechanism is a new `MatchesService.createMatchGuarded`**,
called from both `MatchmakingService` (wrapped in its own
`$transaction`, right after the Redis pop) and `ChallengesService.accept`
(inside its existing transaction, replacing a direct `createMatch` call).
It:
1. Acquires a Postgres advisory transaction lock
   (`pg_advisory_xact_lock(hashtext(userId))`) for every involved user,
   **sorted ascending first** — the same fixed-ordering discipline
   `SettlementService.settle` already uses for multi-wallet locking, so
   two calls sharing two users can never acquire the locks in reverse
   order.
2. Re-checks, under those locks, that none of the users holds a
   `WAITING`/`READY`/`ACTIVE` match.
3. Only then creates the match, inside the same transaction.

There is no single row to lock for "is this user about to be in a
match" — that fact doesn't exist as a row until the match is created.
An advisory lock is the standard Postgres answer to exactly this shape
of problem (synchronizing on a logical key, not a physical row), and it
requires no schema change and no new "who's busy" column to keep
consistent across every termination path. The lock is transaction-scoped
and released automatically on commit or rollback — no explicit unlock
code, no risk of a held lock surviving a crash.

This closes the real race found during the audit: two concurrent
challenge-accepts (or an accept racing a matchmaking-join) sharing a
user could previously both pass a plain `SELECT`-based check before
either had created its match, and both would succeed. Advisory locks
make the second call's check block until the first's transaction
resolves, so it always sees the first's already-created match.

### 2. Redis and Postgres remain separate consistency boundaries — recoverable, not pretended-atomic

Matchmaking's Lua script already atomically pops exactly `minPlayers`
users from Redis once enough are queued. That pop and the Postgres-side
`createMatchGuarded` call are **not** one atomic operation across both
systems — they cannot be, and this ADR does not pretend otherwise. If
`createMatchGuarded` throws (one of the popped users turns out to
already hold a conflicting match, formed via some other path in the
narrow window since the pop), `MatchmakingService.join` recovers
explicitly: it re-checks each popped user's current match state, and
**re-queues whichever ones are genuinely still free** (pushed back to
the front of their queue, claim re-established) rather than silently
dropping them. The specific user who actually conflicts gets a direct
`ConflictException` if they're the caller, or is simply left out of the
requeue if they're not. This is the "recoverable solution with explicit
invariants," per the spec's instruction, for a race that spans two
different storage systems — not a claim that it can't happen.

### 3. Server-authoritative turn timers: a real column, not an in-memory timer

**`Game.turnTimeoutSeconds`** (nullable) is the trusted configuration
source — a catalog column, editable only via a migration, never a
request parameter or a client-supplied value. `null` means "no timer for
this game." Both seeded games (Tic-Tac-Toe, Checkers) get an explicit
`60` via a hand-written backfill migration — a deliberately generous
default, not an aggressive one that would make normal play unusable.

**`Match.turnDeadlineAt`** is the authoritative, per-match deadline — a
real Postgres column, not a `setTimeout`/in-memory timer. This is the
central design choice that makes the feature restart-safe and
multi-instance-safe *by construction*: there is no "recovery" step
needed after an API restart, because the deadline was never only in that
process's memory to begin with. The very next sweep tick (on whichever
instance happens to run it) picks up exactly where things left off.

It is set:
- When a match becomes `ACTIVE` — at creation for free play
  (`MatchesService.createMatch`), or at the stake-confirmation flip for
  a staked match (`MatchStakesService.confirmStake`) — not at `WAITING`
  creation time, since no one can move until the match is actually
  playable.
- **Refreshed on every accepted `MOVE`**, for whoever holds the turn
  next, inside `MatchesService.submitCommand`'s existing row-locked
  transaction.
- Cleared (`null`) the instant the match reaches any terminal status.

**Checkers' forced multi-jump is preserved by this same uniform rule,
with no special-casing.** A multi-jump continuation keeps
`currentTurnUserId` on the same player across several accepted
commands (see `CheckersModule.applyMove`'s `mustContinueFrom` handling).
Each jump within that chain is still a distinct accepted command, so
each one restarts the clock for that player's *next* jump — this is
correct, not a bypass: a player genuinely continuing to jump is making
real, server-validated progress every `turnTimeoutSeconds`, and a player
who stalls mid-chain (makes no further move at all) still times out on
schedule, exactly like a stalled ordinary turn.

**Expiry processing (`MatchTimeoutService.processTurnTimeout`) reuses
the exact same `SELECT ... FOR UPDATE` row lock** `submitCommand` itself
takes. This is the whole concurrency story for this feature: a move
racing a timeout sweep for the same match always serializes on that
lock; whichever transaction commits first wins, and the second re-reads
fresh state and finds either `status !== 'ACTIVE'` or a
`turnDeadlineAt` that's no longer in the past, and safely no-ops. The
same reasoning makes multiple API instances running the sweep
concurrently safe without any distributed-lock library — the Postgres
row lock *is* the distributed lock, exactly the same reasoning the
pre-existing abandonment/waiting-timeout sweeps already rely on.

**Outcome on expiry**: the turn-holder forfeits; the other participant
is credited `winnerUserId`, `terminationReason: 'TURN_TIMEOUT'` — the
same shape as a disconnect forfeit, deliberately, since both are
"this player failed to act in time" at the platform level.

**Config vs. catalog**: the turn clock itself is a per-game `Game`
catalog value (a game-rules concern — "do not assume every game has
identical timeout semantics"). The *draw-offer* window
(`MATCH_DRAW_OFFER_TIMEOUT_MS`, default 60s) is a single global env-var
config value instead, since it's a platform UX concern that has nothing
to do with any particular game's rules.

### 4. Resign and draw offers: new `MatchCommand` types, same pipeline, same lock

`MatchCommand.type` was already a free-form `String` column, written
only as the literal `'MOVE'` — no schema change was needed to add
`'RESIGN'`, `'DRAW_OFFER'`, `'DRAW_ACCEPT'`, `'DRAW_REJECT'`.
`SubmitCommandDto.type` is a new optional field (`@IsIn(...)`, default
`'MOVE'`) — fully backward-compatible with any client that omits it.

All four new types are handled **inside the exact same locked
transaction** as a move, in `MatchesService.submitCommand` — not a
separate endpoint, not a separate lock. This is what makes "a move
racing a resign" or "two simultaneous draw actions" deterministic: they
serialize on the same `Match` row lock a move submission already uses.

**Resignation**: the authenticated submitter always forfeits — there is
no field anywhere in the payload for "who resigns," so a losing
participant resigning *on behalf of* the opponent is impossible by
construction, not by a check that could be gotten wrong. A resignation
submitted against a non-`ACTIVE` match (already decided by a move,
timeout, or an earlier resignation) hits the same "this match has
already ended" rejection every late move already gets — idempotent and
safe by the same pre-existing mechanism, not new logic.

**Draw offers**: two new `Match` columns,
`pendingDrawOfferByUserId`/`pendingDrawOfferExpiresAt`. Semantics,
explicitly decided and documented per the spec's instruction:
- A new `DRAW_OFFER` from the user who *already* has the pending offer
  refreshes/replaces it (extends the expiry).
- A new `DRAW_OFFER` from the *other* participant, while an offer is
  already pending, is **rejected** ("accept or reject it instead") —
  simpler and less ambiguous than treating a crossed offer as an
  implicit acceptance.
- `DRAW_ACCEPT` requires a currently-active (unexpired) offer from the
  *other* participant — accepting your own offer is rejected by
  construction (the check is `pendingDrawOfferByUserId === userId` →
  reject), closing "a user must not accept their own offer."
- `DRAW_REJECT` is usable by **either** participant — the offerer
  withdrawing their own offer, or the recipient declining it — since
  both produce the identical effect (clear the pending state) and a
  mobile UI only ever needs one "decline/cancel" affordance regardless
  of which side the viewer is on.
- An offer is lazily treated as expired the instant
  `pendingDrawOfferExpiresAt` has passed, wherever it's consulted — no
  separate "has this gone stale" state to get out of sync. A periodic
  sweep (`clearStaleDrawOffers`) additionally clears a stale,
  never-answered offer's columns for display hygiene, since otherwise a
  client would keep seeing a "pending" offer that's actually long dead
  until some other command happened to touch the match.
- A move submitted while an offer is outstanding **implicitly withdraws
  it** — choosing to keep playing is a clear enough signal, and it
  avoids a stale offer silently lingering against a board that's since
  changed.
- `DRAW_ACCEPT` completes the match exactly like a board draw
  (`resultIsDraw: true`, `winnerUserId: null`), with
  `terminationReason: 'DRAW_AGREED'` distinguishing it from a `null`-
  reason board draw decided by the game's own rules. It reuses
  settlement's existing `DRAW` → `computeRefundSettlement` path
  unchanged — a draw offer never needed a new financial code path, only
  the same two `Match` fields a board draw already sets.

**Game capabilities**: `GameModule` gained `supportsResignation`/
`supportsDraws` (both `true` for Tic-Tac-Toe and Checkers). A future game
that genuinely cannot represent one (e.g. no tie state) sets the flag
`false`, and the command is rejected the same way an out-of-turn move
already is — explicit, not a silent universal assumption.

### 5. Terminal-outcome semantics: extend `MatchTerminationReason`, not `GameResult`

`GameResult` (the `GameModule`-facing interface) **stays binary**
(`winnerUserId`/`isDraw`) — deliberately. It represents "what the board
decided," which genuinely is binary for every game implemented so far,
and changing it would mean touching both `TicTacToeModule.getResult`
and `CheckersModule.getResult` for no benefit, since neither needs to
report anything richer about the board itself.

Instead, **`MatchTerminationReason` gained three values**:
`RESIGNATION`, `TURN_TIMEOUT`, `DRAW_AGREED` — extending the *existing*
column that already distinguished `WAITING_TIMEOUT`/
`CANCELLED_BY_PLAYER`/`ABANDONED_DISCONNECT` from a `null`-reason
normal win/draw. Combined with the pre-existing `winnerUserId`/
`resultIsDraw`, this triple now distinguishes every outcome the spec
requires:

| Outcome | `winnerUserId` | `resultIsDraw` | `terminationReason` |
|---|---|---|---|
| Normal win | opponent | false | `null` |
| Normal (board) draw | `null` | true | `null` |
| Resignation | opponent | false | `RESIGNATION` |
| Turn timeout | opponent | false | `TURN_TIMEOUT` |
| Agreed draw | `null` | true | `DRAW_AGREED` |
| Disconnect forfeit | opponent | false | `ABANDONED_DISCONNECT` |
| Stake-commit timeout | `null` | false | `WAITING_TIMEOUT` |
| Cancelled by player | `null` | false | `CANCELLED_BY_PLAYER` |

This is fully backward-compatible with every historical row: `null`
already meant "normal game-rules outcome," and continues to, with no
backfill required. `SettlementService` needs **no changes at all** —
its branching already only reads `status`/`winnerUserId`/`resultIsDraw`,
never `terminationReason`, so every new terminal pathway settles through
the exact same, already-proven code.

This closes outstanding-work item 16's actual complaint (no way to
represent resignation/timeout *anywhere* in the shared, platform-level
contract) without the larger, riskier change of extending `GameResult`
itself. The one narrower nuance item 16 also mentioned — Checkers'
*own* internal distinction between "no legal move" and "no remaining
pieces" — remains private to Checkers' state, unchanged; see
`docs/development/OUTSTANDING_WORK.md` for that carved-out remainder.

### 6. Realtime protocol consistency

The `match:completed` event's abandonment-forfeit payload used `reason`;
every other emit site used no such field at all. Fixed to
`terminationReason` everywhere (matching the `Match` column name
exactly), and now populated on every `match:completed` emit, not just
disconnect forfeits. Confirmed safe to rename: the mobile client never
reads fields off the raw push payload at all — every push handler
treats the event as "something changed, go re-fetch via REST" (see
`MatchController._refreshFromPush`), so this is a pure consistency fix
with zero client-side migration needed.

## Alternatives Considered

- **A per-user "busy" column on `User` (e.g. `activeMatchId`), swapped
  atomically via a single `UPDATE ... WHERE active_match_id IS NULL`
  across both users** — considered for duplicate-match prevention;
  rejected as needing every termination path (resign, timeout,
  disconnect, waiting-timeout, draw-accept, normal completion) to
  reliably clear it, multiplying the surface area for a "user stuck
  unable to start a new match" bug, for no stronger a guarantee than the
  advisory-lock approach already provides.
- **A Redis-based distributed lock for turn-timeout processing** —
  rejected; the existing Postgres row lock already gives the exact same
  guarantee for free, and introducing a second locking primitive for one
  feature would be inconsistent with how every other sweep in this
  codebase already achieves multi-instance safety.
- **Extending `GameResult` with a `reason` field** — rejected; see
  Decision 5. The platform-level `MatchTerminationReason` column already
  existed and already generalizes correctly without touching either
  game module's return type.
- **Treating a crossed `DRAW_OFFER` (both sides offering at once) as an
  implicit mutual acceptance** — rejected as needlessly clever; requiring
  an explicit `DRAW_ACCEPT` after either side's offer is simpler to
  reason about and to test.
- **A dedicated `DRAW_CANCEL` command distinct from `DRAW_REJECT`** —
  rejected; both produce the identical effect (clear the pending
  offer), so one command usable by either side is simpler for both the
  server and the mobile UI.

## Consequences
- A future 3-/4-player game's turn timer and duplicate-match guard need
  no redesign — `createMatchGuarded` already accepts an arbitrary
  `playerUserIds` array, and the turn-timeout sweep already treats
  "the opponent" generically as "every other participant" (though
  `winnerUserId` remains single-valued, an existing limitation shared
  with every other win path, not introduced here).
- A future game that needs genuinely different timeout semantics (e.g.
  a per-move *and* per-match overall clock, chess-clock-style) is an
  additive change to `Game`'s catalog columns, not a rework of the
  sweep's locking strategy.
- The advisory-lock-based duplicate-match guard depends on every match-
  forming path going through `createMatchGuarded` rather than
  `createMatch` directly — any *future* path that creates a `Match`
  must remember this, documented here and in `MatchesService`'s own
  doc comments.
