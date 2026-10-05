# ADR-014: Match Commands Travel Over REST, Not WebSocket

## Status
Accepted — Phase 4

## Context
[ADR-006](ADR-006-realtime.md) (Phase 1) chose Socket.IO specifically
because "player actions must reach the server quickly." Phase 4 had to
decide, concretely: does a player's move (and other mutating match
commands) travel over the WebSocket gateway, or over REST?

This was surfaced explicitly to the project owner before implementation
(not decided silently), since it conflicts with ADR-006's original
framing and affects the whole realtime architecture, the testing
strategy, and every future game.

## Decision
**Match commands travel over REST** (`POST /matches/:id/commands`),
through the exact same `JwtAuthGuard`, DTO validation (`class-validator`),
rate limiting (`@Throttle`), and idempotency pattern Phase 2/3 already
established for every other authenticated mutation. The result is then
**pushed** to both players over the existing Socket.IO gateway
(`match:state`, `match:completed`, ...).

The WebSocket gateway (`RealtimeGateway`) is used exclusively for:
- Server→client push (state updates, matchmaking/challenge
  notifications, presence-adjacent events).
- `match:join` — a client subscribing to a specific match's room, with
  real membership re-verified server-side before the socket is added to
  that room (never trusted from the payload).

## Rationale
- **Reuses proven security infrastructure instead of rebuilding it.**
  `JwtAuthGuard`, class-validator DTOs, named `@Throttle` profiles, and
  the `@@unique`-constraint idempotency pattern (Phase 3's
  `Deposit`/`Withdrawal`, Phase 4's `MatchCommand`) all already exist for
  REST. Accepting commands over WebSocket instead would mean building a
  parallel authentication/validation/rate-limiting/idempotency system for
  the WS transport — a second thing to get right and keep right, for a
  dubious benefit (see below).
- **Turn-based games don't need WS-level latency for the mutation
  itself.** Tic-Tac-Toe (and every other initially-planned PlayLe game —
  Dice, Checkers, Ludo, Find the Marble) is turn-based; the difference
  between a ~50-100ms REST round trip and a WebSocket emit is
  imperceptible against human reaction time. A future genuinely
  real-time-physics game (Penalty, Ice Hockey, a G-Switch-style game)
  might reconsider this per-game if continuous, high-frequency input
  becomes a real requirement — this ADR governs the current generic
  platform, not every future game unconditionally.
- **Far easier to test correctly.** Every other mutating endpoint in this
  codebase has a `supertest`-based e2e test proving real concurrency
  behavior (Phase 3's withdrawal race; Phase 4's concurrent-command race
  in `test/matches.e2e-spec.ts`). Testing the same guarantees over a raw
  WebSocket message would require a parallel, more fragile test
  infrastructure for no added confidence.
- **Consistent with Phase 3's precedent.** Deposits/withdrawals — also
  state-changing, also needing idempotency and concurrency safety — went
  through REST with WS used only for push. Match commands follow the
  same shape.

## Alternatives Considered
- **Commands over WebSocket, exactly as ADR-006 originally implied** —
  rejected for the reasons above. Not "wrong," but a worse fit for this
  platform's actual needs than the REST-with-push hybrid.
- **Commands over WebSocket for low-latency games, REST for turn-based
  ones** — rejected as premature: no low-latency game exists yet, and
  designing two command-transport systems before either is needed is
  exactly the kind of overbuilding the project avoids.

## Consequences
- `RealtimeGateway` stays comparatively simple: authentication at
  handshake, personal (`user:{userId}`) and per-match (`match:{matchId}`)
  rooms, and a small set of inbound messages (`match:join`,
  `presence:heartbeat`) that don't mutate anything.
- Every future game's moves/commands go through `MatchesService.submitCommand`
  via REST, inheriting its row-locking concurrency guarantee and
  idempotency for free — a future game module does not need to think
  about either.
- If a future game genuinely needs WebSocket-transported commands (e.g.
  continuous input for a physics-based game), that will require a new,
  explicitly-scoped ADR revisiting this decision — it is not assumed to
  extend automatically.
