# Phase 9 Report — Match Lifecycle Integrity, Matchmaking Correctness & Game Result Semantics

Written in Phase 11 from repository evidence (Git history, the code on
`main`, and GitHub Actions results). Numbers that cannot be verified from
those sources are not stated.

## Scope
Close outstanding-work items 13–17 (turn timer, `WAITING`-blind duplicate-match
check, stale timeout comment, binary `GameResult`, no resign/draw commands).
Design and rationale: [ADR-024](../decisions/ADR-024-match-lifecycle-integrity.md).

## Commit
`085dfd3973582d2185405abf06c39f283ec9d926` (2026-10-13), 43 files, +2800 / −275.

## Evidence by level

| Level | Status | Evidence |
|---|---|---|
| **Implemented** | Yes | `Game.turnTimeoutSeconds` / `Match.turnDeadlineAt` with `MatchTimeoutService.processTurnTimeout` under the same row lock `MatchesService.submitCommand` uses; `MatchesService.createMatchGuarded` (sorted advisory transaction locks) used by matchmaking and challenge-accept; `RESIGN` / `DRAW_OFFER` / `DRAW_ACCEPT` / `DRAW_REJECT` commands; `MatchTerminationReason` gained `RESIGNATION` / `TURN_TIMEOUT` / `DRAW_AGREED`; `GameModule.supportsResignation` / `supportsDraws`. Two migrations (`phase9_match_lifecycle_integrity`, `backfill_turn_timeout_seconds`). Mobile: shared `MatchActionBar` / `DrawOfferBanner`, a countdown in `MatchStatusBar`. All present on `main`. |
| **Locally tested** | Claimed, **not reproduced** | The repo's earlier prose says the new tests passed locally against real Postgres; no artifact of that run exists and none was re-run in Phase 11 (this machine has no Postgres/Redis). |
| **CI verified** | **Yes** | Run [38437718801](https://github.com/Ahmed004-art/playLe/actions/runs/38437718801) on `085dfd3`: Admin, Backend (api, including the Postgres/Redis e2e suite) and Mobile all success. |
| **Visually inspected** | No evidence | The new `MatchActionBar`, `DrawOfferBanner` and the countdown have no recorded visual review. (Phase 11's Chrome preview later exercised the countdown and action bar through the Dice screen only.) |
| **Verified on a device** | No evidence | None recorded. |

## Tests added
Counted from the commit's diff by matching `it(`/`test(`/`testWidgets(`
declarations on added lines (declared tests, not pass counts):

| File | Declarations |
|---|---|
| `apps/api/test/match-lifecycle.e2e-spec.ts` | 20 |
| `apps/api/test/checkers.e2e-spec.ts` | 1 |
| `apps/api/test/matchmaking.e2e-spec.ts` | 1 |
| `apps/api/test/responsible-gaming-limits.e2e-spec.ts` | 1 |
| `apps/mobile/test/features/tic_tac_toe/tic_tac_toe_screen_test.dart` | 8 |
| `apps/mobile/test/features/checkers/checkers_screen_test.dart` | 3 |
| **Total declarations** | **34** |

The phase's earlier prose cites "8 new backend e2e tests, 8 new mobile widget
tests" for the resign/draw subset; that is a narrower claim than the table
above (which counts the whole commit) and the two are not in conflict.

## Outstanding / blocked
- `GameResult` stays binary; Checkers' internal "no legal move" vs "no pieces" nuance is not exposed (`OUTSTANDING_WORK.md` item 16, narrow remainder).
- `resign` / timeout handling assumes a single opponent and `winnerUserId` is single-valued — a limitation for any future 3-4 player game (noted in ADR-024, "Consequences").
- Local e2e still needs Postgres/Redis (item 11); CI is the authority.
