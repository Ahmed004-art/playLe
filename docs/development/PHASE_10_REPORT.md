# Phase 10 Report — Dice

Written in Phase 11 from repository evidence (Git history, GitHub pull-request
and Actions data, local test runs). Design and rationale:
[ADR-025](../decisions/ADR-025-dice-game-module.md).

## Outcome
Dice is implemented, reviewed and **merged**: pull request #1, merge commit
`d051115271ed795e6588fdd0de9498097406e536` (2026-10-19T12:00:21Z) on `main`.
The merge tree is byte-identical to the reviewed PR head
`d0ce1decd50719a296b7187ec8b79a6642b752e7`. Dice ships **disabled**
(`enabled = false` in the seed migration); implementing it is not
authorization to launch it, least of all for real money.

## Commits and CI
| Commit | What | CI run | Result |
|---|---|---|---|
| `40ef3a2` | Dice implementation | [39194206373](https://github.com/Ahmed004-art/playLe/actions/runs/39194206373) | failed: Mobile (format), Backend (e2e spec bugs) |
| `ba329ad` | Fix e2e spec (unique emails, restriction cleanup) | [39194704725](https://github.com/Ahmed004-art/playLe/actions/runs/39194704725) | Backend + Admin passed; Mobile format failed |
| `38e9f4a` | `dart format` (Dart 3.12.2) | [39196996777](https://github.com/Ahmed004-art/playLe/actions/runs/39196996777) | Mobile tests failed (layout overflow) |
| `a946400` | Fix Dice layout overflow | [39224780342](https://github.com/Ahmed004-art/playLe/actions/runs/39224780342) | all success |
| `d0ce1de` | Short-screen layout; hide round caption after finish | [39243703674](https://github.com/Ahmed004-art/playLe/actions/runs/39243703674) | all success |
| `d051115` (merge) | merge of PR #1 | [39248730906](https://github.com/Ahmed004-art/playLe/actions/runs/39248730906) (push to `main`) | all success |

## Evidence by level

| Level | Status | Evidence |
|---|---|---|
| **Implemented** | Yes | `apps/api/src/games/dice/` (rules, injectable RNG, types), registration in `GamesModule`, the seed migration `20261019120000_seed_dice_game`, the mobile `features/dice/` screen/widgets, ADR-025. No change to `MatchesService`, settlement, ledger, eligibility, the Prisma schema, `GameModule` or `GameResult`. |
| **Locally tested** | Yes (API unit + mobile) | API unit suite 177 → 231 tests with the Dice spec, all passing. Mobile: all 38 Dice tests passing, whole suite 183 passing at the PR head. Local e2e **not** runnable (no Postgres/Redis). |
| **CI verified** | Yes | Backend (incl. the Postgres/Redis e2e suite), Admin and Mobile (format, analyze, tests, Android debug build) green on the PR head and on the merge commit — table above. Per-test counts from CI are not available (job logs need authentication). |
| **Visually inspected** | Partly — **Chrome preview only** | Headless Chrome renders of the real `DiceScreen`/`AppTheme` from fixture states at 320×640 and 390×844 (2× density), with Arial standing in for Roboto. Inspected: active/waiting/tie/round-won/finished/resignation/draw/timeout/staked states, pips correctness, no clipping. This is not an Android check and used fixture data, not a live match. |
| **Verified on a device** | **No** | No Android device or emulator was available. |

## Tests
Declared tests at the merge commit (counted by pattern; `it.each` rows count once):

| File | Declarations |
|---|---|
| `apps/api/src/games/dice/dice.module-impl.spec.ts` (unit) | 34 `it` + 3 `it.each` |
| `apps/api/test/dice.e2e-spec.ts` (e2e, CI-only) | 21 `it` + 2 `it.each` |
| `apps/mobile/test/features/dice/dice_screen_test.dart` | 33 |
| `apps/mobile/test/features/dice/dice_models_test.dart` | 5 |

The e2e suite covers: disabled-by-default catalog, server-authoritative rolling,
rejection of client-supplied dice/results, out-of-turn and non-participant
rejection, ties, resignation, rejected draw offers, replayed and concurrent
duplicate commands (no double roll), a roll racing the timeout sweep, staked
win / draw / resignation / timeout settlement through the unchanged ledger and
10% fee, and self-exclusion on the Dice path.

## Outstanding / blocked (none resolved by the merge)
- Android device/emulator verification and review of the roll animation (`OUTSTANDING_WORK.md` item 22).
- Large system-font verification on a device (Phase 11 added widget-level tests only; item 25).
- Legal and payment-provider eligibility for real-money games of chance (items 3, 20); Dice is not "provably fair" (item 21).
