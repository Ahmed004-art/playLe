# ADR-015: Generic Game-Module Architecture

## Status
Accepted — Phase 4 (implemented; Tic-Tac-Toe is the one real game module)

## Context
`docs/architecture/GAME_ENGINE.md` (Phase 1, documentation-only) already
sketched a `GameRules` interface so the match/session layer never needs
to branch on which specific game is being played. Phase 4 had to make
this concrete for a real, playable game (Tic-Tac-Toe) while keeping the
platform genuinely reusable for every future game (Dice, Checkers,
Penalty, Ice Hockey, a G-Switch-style game, Ludo, Find the Marble).

## Decision

### The contract
`GameModule<TState, TMove>` (`src/games/contracts/game-module.interface.ts`):
`createInitialState`, `currentTurnUserId`, `validateMove`, `applyMove`,
`isFinished`, `getResult`, `serializeState`/`deserializeState`. `TState`
is a plain, JSON-serializable object entirely private to the module —
the platform persists it opaquely in `Match.state` and never inspects
its shape.

### The chain
```
MatchesService (the generic "GameManager")
    ↓ looks up Match.gameId
GameRegistry
    ↓
GameModule (interface)
    ↓
TicTacToeModule
```
`GameRegistry` collects every bound `GameModule` into a lookup map via a
`GAME_MODULES` multi-provider DI token (`src/games/games.module.ts`).
Registering a future game means adding one line to that provider's
`useFactory` array and implementing the interface — no change to
`GameRegistry`, `MatchesService`, matchmaking, or challenges.

### What's a structured column vs. opaque state
`Match` (`gameId`, `gameVersion`, `status`, `stateVersion`, `winnerUserId`,
`resultIsDraw`, `terminationReason`, timestamps) holds everything the
*platform* needs to query, list, and display without knowing game rules.
`Match.state` (JSON) holds only what the *game module* needs to compute
the next move — for Tic-Tac-Toe: the board, player order, move count.
`gameVersion` is snapshotted at match creation from `Game.version`, so a
future rule-version bump never retroactively changes an in-flight or
historical match's behavior.

### Catalog vs. module
`Game` (Postgres table) is the catalog: metadata (`displayName`,
`description`, `minPlayers`/`maxPlayers`, `enabled`, `version`, `iconKey`)
that can be edited (e.g. disabled) without a code change. A `GameModule`
is the code implementing that game's actual rules. The two are linked by
`id` and must agree, but the catalog row existing doesn't by itself make
a game playable — a registered `GameModule` is also required, and
`GameRegistry.get` throws `NotFoundException` if one isn't found for a
given `gameId`. Phase 4 seeds exactly one catalog row (`tic_tac_toe`,
hand-added `INSERT` in the migration) with exactly one registered module.

### Server authority (reaffirming ADR-008)
`validateMove`/`applyMove`/`isFinished`/`getResult` are the **only**
source of truth for whose turn it is, whether a move is legal, and who
won. `MatchesService.submitCommand` never accepts a client-asserted
outcome — see [ADR-008](ADR-008-server-authoritative.md) and
[ADR-014](ADR-014-realtime-command-transport.md) for how a command
actually reaches this pipeline.

## Tic-Tac-Toe as the Reference Implementation
`src/games/tic-tac-toe/` is deliberately pure and dependency-free (no
Nest, no Prisma import) so its 8-line-win-check rule logic is fully
unit-testable in isolation (`tic-tac-toe.module-impl.spec.ts`, 14 tests
covering every win line, draws, and all four move-rejection cases). This
is the pattern every future game module should follow: rules are a plain
class implementing `GameModule`, tested without any platform
infrastructure; only `GameRegistry`'s wiring touches Nest.

## Alternatives Considered
- **A single giant switch/if-chain on `gameId` inside `MatchesService`**
  — rejected outright; this is exactly the coupling the interface exists
  to prevent, and explicitly named as unacceptable in the Phase 4
  specification ("do not hard-code Tic-Tac-Toe into generic match logic").
- **Storing the entire `Match` row as one JSON blob** — rejected; status,
  timestamps, winner, and termination reason need to be queryable
  (admin visibility, match history, the timeout sweep) without
  deserializing and branching on game-specific state. Only the parts a
  game module actually owns are opaque.
- **A separate `GameVersion` table instead of a scalar `Match.gameVersion`
  snapshot** — rejected as unnecessary for Phase 4; a single integer
  snapshot is sufficient until a real multi-version-coexistence need
  arises.

## Consequences
- Every future game (per `docs/architecture/GAME_ENGINE.md`'s planned
  list) is implemented as a new `src/games/<name>/` module plus one
  catalog row — not a platform change.
- A future game needing physics/continuous simulation (Penalty, Ice
  Hockey, a G-Switch-style game) still fits this contract: its `TState`
  just holds whatever that simulation needs between moves/ticks, and the
  module's `applyMove` is where that simulation step happens. Whether
  such a game also needs a different command transport is a separate,
  future decision — see ADR-014's consequences.
- `Match.state`'s shape is versioned implicitly via `gameVersion`; a
  breaking change to a game's state shape must be paired with a version
  bump and (if needed) a migration path for in-flight matches at that
  old version — not designed in Phase 4, since no game has shipped a
  second version yet.
