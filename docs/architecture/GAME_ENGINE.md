# Game Engine Architecture

**Implemented as of Phase 4.** This document originally described the
intended architecture before any game logic existed (Phase 1); the
conceptual model below held up and is now the real, running
implementation, refined into a concrete contract — see
[ADR-015](../decisions/ADR-015-game-module-architecture.md) for the exact
interface and [ADR-014](../decisions/ADR-014-realtime-command-transport.md)
for how a player's move actually reaches the server. One game,
Tic-Tac-Toe, is implemented end-to-end; the contract is designed so
additional games are new modules, not platform changes.

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

Every game (Tic-Tac-Toe today; Dice, Checkers, Penalty, Ice Hockey, a
G-Switch-style game, Ludo, Find the Marble, and future games later) implements
the same contract — the real, implemented `GameModule<TState, TMove>`
interface (`apps/api/src/games/contracts/game-module.interface.ts`):

```ts
interface GameModule<TState = unknown, TMove = unknown> {
  readonly gameId: string;
  readonly version: number;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  createInitialState(playerUserIds: string[]): TState;
  currentTurnUserId(state: TState): string | null;
  validateMove(state: TState, userId: string, move: unknown): MoveValidationResult;
  applyMove(state: TState, userId: string, move: TMove): TState;
  isFinished(state: TState): boolean;
  getResult(state: TState): GameResult | null; // winner(s)/draw, for future prize-pool settlement
  serializeState(state: TState): Prisma.JsonValue;
  deserializeState(json: Prisma.JsonValue): TState;
}
```

A `GameRegistry` (DI multi-provider token `GAME_MODULES`) collects every
bound module into a `Map<gameId, GameModule>`. `MatchesService` is the
game-agnostic driver: it looks up the right module by `Match.gameId` and
runs every match through the same lifecycle (create -> accept a command ->
validate -> apply -> check completion) without ever branching on which
game it is. Adding a new game means implementing this interface and
registering it — never modifying `MatchesService` itself. See
`apps/api/src/games/tic-tac-toe/tic-tac-toe.module-impl.ts` for the
reference implementation.

## Server Authority

Per [ADR-008](../decisions/ADR-008-server-authoritative.md), every action
is validated server-side and every resulting state change is computed
server-side. A client is never trusted to report its own outcome, score,
or a match result. This is non-negotiable given real-money staking.
Concretely: a move is submitted over REST
(`POST /matches/:id/commands`), validated and applied inside a
row-locked, atomic transaction (`MatchesService.submitCommand`), and the
resulting state is pushed to both clients over WebSocket — a client
never computes or asserts the outcome itself (see
[ADR-014](../decisions/ADR-014-realtime-command-transport.md)).

## Relationship to the Financial System

When a match completes, its result (`getResult()` / `Match.winnerUserId`/
`resultIsDraw`) is what will eventually drive settlement in a future
Betting/Ledger integration: the winner(s) and the prize-pool math (see
`CLAUDE.md`, "Financial Rule", and
[ADR-009](../decisions/ADR-009-financial-ledger.md)). **As of Phase 4,
the game engine does not touch money at all** — matches have no stakes,
holds, or prize pools, and the `PRIZE`/`PLATFORM_FEE` ledger types remain
reserved but unproduced. Wiring a match result into the wallet/ledger is
explicitly out of scope until a dedicated, explicitly-approved phase.

## Games

1. **Tic-Tac-Toe** — implemented (Phase 4), the reference game proving the
   `GameModule` contract end-to-end.
2. Dice
3. Checkers
4. Penalty
5. Ice Hockey
6. Stickman / G-Switch-style game
7. Ludo
8. Find the Marble

2-8 remain planned for later phases, built on the same `GameModule`
contract Tic-Tac-Toe already proves out.

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
