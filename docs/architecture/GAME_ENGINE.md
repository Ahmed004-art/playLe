# Game Engine Architecture (Future — Not Implemented in Phase 1)

This document describes the intended architecture for PlayLe's game engine.
**No game logic is implemented in Phase 1.** This is design documentation
only, so later phases can build games without restructuring the platform.

## Conceptual Model

```
Game Definition
      |
Game Rules
      |
Game Session
      |
Authoritative State
      |
Player Action
      |
Validation
      |
State Update
      |
Game Event
      |
Clients
```

- **Game Definition** — static metadata about a game: its name, supported
  player counts (2-4 in Phase 1's scope, architecture allows more later),
  and which rule set implementation it uses.
- **Game Rules** — the pure logic that knows how to validate a move and
  compute the next state for one specific game (e.g. Checkers rules vs.
  Ludo rules). Each game implements a common rules interface so the
  session/session-management layer never needs game-specific branching.
- **Game Session** — a live instance of a match between N players, created
  once matchmaking/challenge produces a set of staked players (staking is
  a future phase). Owns the authoritative state for that match.
- **Authoritative State** — the single source of truth for "what is true
  right now" in a match. Lives server-side only.
- **Player Action** — an intent sent by a client (e.g. "move piece from A
  to B"), never trusted as fact.
- **Validation** — the server checks the action against the current
  authoritative state and the game's rules before accepting it.
- **State Update** — on a valid action, the server computes and persists
  the new authoritative state.
- **Game Event** — the server emits the resulting state (or a diff) to all
  connected participants over the WebSocket gateway (see ADR-006).
- **Clients** — render whatever the server sends. Clients do not compute
  outcomes themselves.

## Why a Common Rules Interface

Every game (Dice, Checkers, Tic-Tac-Toe, Penalty, Ice Hockey, a
G-Switch-style game, Ludo, Find the Marble, and future games) will
implement the same abstract contract, roughly:

```
interface GameRules {
  createInitialState(players): GameState
  validateAction(state, action, playerId): ValidationResult
  applyAction(state, action): GameState
  isComplete(state): boolean
  getResult(state): MatchResult   // winner(s), for prize-pool settlement
}
```

This lets `GameSessions` (the future session-management module) stay
game-agnostic: it drives any game through the same lifecycle
(create -> accept actions -> validate -> apply -> check completion ->
settle) without knowing Checkers rules differ from Ludo rules. Adding a new
game means implementing this interface, not modifying the session/platform
core.

## Server Authority

Per [ADR-008](../decisions/ADR-008-server-authoritative.md), every action
is validated server-side and every resulting state change is computed
server-side. A client is never trusted to report its own outcome, score,
or a match result. This is non-negotiable given real-money staking.

## Relationship to the Financial System

When a Game Session completes, its result (`getResult()`) is what
eventually drives settlement in the future Betting/Ledger modules: the
winner(s) and the prize-pool math (see `CLAUDE.md`, "Financial Rule", and
[ADR-009](../decisions/ADR-009-financial-ledger.md)). The game engine
itself never touches money directly — it only produces a result that a
separate, dedicated settlement process consumes inside an atomic,
auditable transaction.

## Planned Initial Games (Not Implemented Yet)

1. Dice
2. Checkers
3. Tic-Tac-Toe
4. Penalty
5. Ice Hockey
6. Stickman / G-Switch-style game
7. Ludo
8. Find the Marble

## External Games (Future, Separate Concern)

See `docs/architecture/OVERVIEW.md` and Section 27 of the Phase 1
specification. PlayLe will eventually potentially organize competitions
around games that run outside PlayLe entirely (e.g. Free Fire): PlayLe
would organize players, record competition, and manage eligible
stakes/results where legally and technically appropriate, verified through
an approved mechanism. This is architecturally distinct from the
`GameRules` interface above (no in-process authoritative state to
simulate) and must not be designed as if every external game exposes a
usable API — result verification mechanisms will likely vary per game and
require dedicated design work in their own phase.
