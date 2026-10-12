# ADR-022: Checkers Game Module

## Status
Accepted — Phase 7

## Context
Phase 7's spec calls for a second, complete game — Checkers — implemented
through the existing generic `GameModule` contract (ADR-015) with no
platform changes, proving that contract genuinely generalizes beyond
Tic-Tac-Toe's much simpler rules (a 3x3 board, one kind of piece, a
single move per turn, strict `moveCount % 2` turn alternation). Checkers
needs: an 8x8 board, two kinds of piece (man/king) with different
movement rules, mandatory capture, a multi-jump sequence that can span
several accepted commands within the same turn, and an explicit answer
to "what, exactly, is a draw" — American/English over-the-board checkers
has no universally standard digital draw rule.

## Decision

### State shape: explicit turn and continuation, not derived
Unlike `TicTacToeState.moveCount % 2`, `CheckersState` stores
`currentTurn` directly, plus `mustContinueFrom: Coord | null` — the board
square of a piece that just captured and has at least one further
capture available. While set, `validateMove` accepts only a jump
originating from that exact square; `currentTurnUserId` still returns
the same player. This is the one piece of state Tic-Tac-Toe's contract
never needed and confirms the contract's `TState`/`TMove` generics were
sized correctly — no interface change was needed.

### Board/move representation
`board: (CheckersPiece | null)[][]` (8x8, `board[row][col]`), only dark
squares (`(row + col) % 2 === 1`) ever occupied. A move is
`{ from: Coord, to: Coord }` — a single diagonal step of exactly one
square (simple move) or exactly two squares (a jump, capturing whatever
sits at the midpoint). A multi-jump is therefore several separate
accepted commands (one per hop), each one going through the normal
`MatchesService.submitCommand` pipeline — not a client-submitted path
array. This was chosen over having the client submit the whole path in
one command because it reuses the existing command/push/idempotency
machinery untouched for every hop, and because it lets the UI show each
capture as it lands rather than only the end result.

### Standard American/English rules, not international draughts
- Men move/capture diagonally forward only; kings move/capture
  diagonally in any of the four directions, one square (or a two-square
  jump) at a time — *not* "flying kings" (international draughts' kings,
  which can move any distance along a diagonal). This matches what the
  Phase 7 spec calls "standard American/English checkers rules".
- Capture is mandatory: if any of a player's pieces has a capture
  available anywhere on the board, a simple move is rejected for every
  piece that turn (`validateMove`'s `hasAnyCaptureForPlayer` check) —
  the player may still choose *which* available capture to take, exactly
  as real rules allow.
- A multi-jump must continue with the *same* piece if another capture is
  available from its new square (`mustContinueFrom`).

### Promotion ends the turn, even mid-multi-jump
A man that reaches the farthest row becomes a king immediately
(`applyMove`), and that ends the turn right there — the newly-made king
never continues the same multi-jump sequence as a king, even if a
further king-style capture would otherwise be available from its landing
square. This is a real rule-variant choice (some digital implementations
let a newly-crowned king keep jumping); "promotion stops the piece" is
chosen as the more common tournament-rule convention and, more
importantly, as the one that is unambiguous to implement and test
correctly — see
`checkers.module-impl.spec.ts`, "ends the turn on promotion even when
the newly-made king could jump again".

### The draw rule: 40 half-moves with no capture or man move
American checkers has no single universally standard draw rule for an
indefinite shuffle between two kings. This module adopts the commonly
cited "40-move rule": `movesSinceProgress` resets to 0 on any capture or
any man (non-king) move — the only irreversible kinds of progress — and
increments otherwise; reaching 40 ends the match in a draw
(`DRAW_NO_PROGRESS_LIMIT`). This is an explicit, documented, and tested
choice (not an invented one — see the spec's "declares a draw once 40
half-moves pass" test), made specifically so the match cannot remain
`ACTIVE` (with a staked player's funds held) indefinitely — required by
the Phase 7 spec's "a draw must be handled according to an explicit,
documented rule and not left indefinitely ambiguous."

### Win condition
A player loses the instant they have no legal move available on their
turn — whether because they have zero pieces left or because every
remaining piece is blocked. `hasAnyLegalMoveForPlayer` is evaluated
inside `applyMove` immediately after computing whose turn is next, the
same point `isFinished`/`getResult` are derived at for Tic-Tac-Toe.

### No platform changes
Matchmaking, challenges, the command pipeline (locking, idempotency,
concurrency), realtime push, stake confirmation, and settlement are all
completely unmodified — Checkers only adds a `CheckersModule` registered
in `GamesModule`'s `GAME_MODULES` factory array (mirroring
`TicTacToeModule` exactly) and one seed migration inserting the
`checkers` `Game` row. `checkers.e2e-spec.ts` proves this directly: a
staked Checkers win settles through the exact same `SettlementService`
math (`floor(pool * 10 / 100)` fee) Tic-Tac-Toe already exercises, and a
staked Checkers draw refunds through the same path.

## Alternatives Considered
- **Flying kings (international draughts style)** — rejected; the spec
  explicitly asks for standard American/English rules.
- **A single command carrying the whole multi-jump path** — rejected in
  favor of one command per hop; see "Board/move representation" above.
- **Letting a promoted piece continue its jump as a king** — considered
  and rejected; see "Promotion ends the turn" above.
- **No draw rule (let a shuffle continue indefinitely)** — explicitly
  rejected by the spec itself.
- **A move/turn timer** — not implemented. Checkers inherits the
  existing disconnect-grace-period forfeit (`MatchTimeoutService`,
  unmodified) but there is still no limit on how long a *connected*
  player may think before moving; tracked in
  `docs/development/OUTSTANDING_WORK.md` as a pre-existing platform gap
  (identified during the Phase 7 audit, not introduced by it), not a
  Checkers-specific defect.

## Consequences
- `GameModule<TState, TMove>`'s generics, and the entire command/
  matchmaking/challenge/realtime/settlement pipeline, are now proven
  against a second, materially different game with zero interface
  changes — confirming ADR-015's design.
- A future game with its own multi-step-turn needs (e.g. a game with an
  optional extra action per turn) can follow the same
  `mustContinueFrom`-style pattern: explicit state fields the module
  alone understands, never a platform concept.
- The 40-move draw rule and the "promotion ends the turn" choice are
  both product/rules decisions an owner with real checkers-tournament
  authority could revisit; they are implemented as clearly isolated,
  documented, and tested choices specifically so revisiting either is a
  small, contained change.
