# Phase 11 Report — Verification, Security and Engineering Hardening

Phase 11 builds **no new game** and changes **no** wallet, ledger, settlement,
eligibility, payment-provider behavior or real-money flag. This report is
written from evidence gathered during the phase; the "CI verified" row is
completed from the pull request's own checks, not asserted here in advance.

## Baseline (verified before any edit)
- Base: `origin/main` at `d051115271ed795e6588fdd0de9498097406e536`, the merge commit of PR #1 (Phase 10), merged 2026-10-19T12:00:21Z. Its tree is identical to the reviewed PR head `d0ce1de`.
- CI on the merge commit: run [39248730906](https://github.com/Ahmed004-art/playLe/actions/runs/39248730906) (push to `main`) — Backend, Admin, Mobile all success.
- Dice is on `main` and still seeded `enabled = false`; `REAL_MONEY_GAMING_ENABLED` and `ELIGIBILITY_POLICY_CONFIGURED` still default to `'false'` in `env.validation.ts`.
- Branch: `phase-11-hardening`, created from that exact commit.

## Stage 2 — Shared mobile layout (OUTSTANDING_WORK item 25)
**Audit.** A new test matrix, `apps/mobile/test/core/match/match_chrome_layout_test.dart`, renders the shared match widgets and all three game screens at widths 320 and 390 px and text scales 1.0×, 1.5× and 2.0×, worst realistic content (minutes countdown, large stake amounts, disconnected opponent, draw-offer and result banners, staked game screens with a countdown). Flutter's test font is roughly twice as wide as a real one, so this is a deliberately stricter bar than any real device presents. Before any fix, **47 of 60** combinations failed.

**Causes and fixes** (all minimal; visual identity unchanged at normal sizes):
| Widget | Defect | Fix |
|---|---|---|
| `MatchStatusBar` | fixed `Row` of leading + turn text + countdown overflowed | `Wrap` (status drops to a second line instead of overflowing); `leading` wrapped in a scale-down `FittedBox`; container kept full-width |
| `MatchStakeStatusBar` | non-wrapping text in a `Row` | text in `Expanded` so it wraps |
| `DrawOfferBanner` | text + buttons `Row` overflowed | `Wrap`s |
| `FinancialResultBanner` | button `Row` could overflow | `Wrap` |
| `DiceRollRow` | label/pips and the two dice in non-wrapping `Row`s | `Wrap`s |

**A regression the overflow checks could not see.** The first version of the `MatchStatusBar` fix made the bar shrink-wrap into a narrow centered pill (a bare `Wrap` shrink-wraps). It was caught only by re-rendering the Chrome preview, then fixed (`width: double.infinity`) and covered by a geometry test that asserts the bar spans the available width with the leading widget and the status at the correct edges. That test was confirmed to **fail without the fix** (bar 186 px vs the expected 272/342 px).

The two Dice tests that had been moved to the default (wide) viewport as a Phase 10 workaround now run at phone width again.

## Stage 3 — Dependency security (OUTSTANDING_WORK item 23)
`npm audit` reproduced exactly **8 high-severity findings**, from two advisories, **none fixed in this phase**:

| Advisory | Chain | Patched version | Disposition |
|---|---|---|---|
| GHSA-vfj7-8cjw-p6xm (`braces` ≤ 3.0.3, stack exhaustion on deeply nested brace patterns, CWE-674) | `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces` (5 findings, admin lint tooling) | **none exists** — the advisory lists no patched version and 3.0.3 is the latest published | cannot be fixed by any update or override; accepted with monitoring |
| GHSA-ggr8-5vv4-36mx (`deepmerge-ts` < 8.0.0, stack exhaustion on recursive object graphs, CWE-674) | `prisma` CLI → `@prisma/config` → `deepmerge-ts` 7.1.5 (3 findings, API tooling) | `deepmerge-ts` 8.0.0 | fix not applied (below) |

**Why the `deepmerge-ts` fix was not applied.** `@prisma/config` 6.19.3 pins `deepmerge-ts` exactly (7.1.5); only `@prisma/config` 7.x uses 8.x, which means moving to the Prisma 7 major — an unsafe upgrade to take merely to clear an audit, and not within this phase. A scoped `overrides` entry was tried in a scratch copy (scoped and global forms, plus `npm update`): npm 10.9.8 left the lockfile at 7.1.5 in every case, so the override cannot be delivered cleanly. Hand-editing the lockfile was rejected, and running npm in this lockfile also rewrites unrelated metadata (37 lines of `peer`/`devOptional` flag churn even with no override), which would mix unrelated churn into a security change. **No dependency file was changed.**

**Exposure, stated without relying on "it's a dev dependency":** Prisma's config loader calls only the plain `deepmerge(defaultConfig, userConfig)` function. The repository has no `prisma.config` file, so the merged inputs are Prisma's own defaults — no attacker-supplied object graph reaches it; reaching the bug needs self-referential graphs at the same property path in both inputs. The `braces` path takes glob patterns from the ESLint plugin's own static configuration while linting the repository's files. Neither is reachable from an HTTP request or user input in the running API or admin app. Both are denial-of-service-class (process crash), not code execution or data exposure. This reasoning is exposure analysis, not a claim that the findings are harmless.

**Recommended decision (owner):** accept both, re-run `npm audit` on each dependency update, and fold the `deepmerge-ts` finding into the future Prisma 7 upgrade phase (its own migrations/e2e verification). Revisit `braces` when a patched release is published.

## Stage 4 — Documentation
Added `PHASE_8_REPORT.md`, `PHASE_9_REPORT.md` and `PHASE_10_REPORT.md` (this folder) from Git history and GitHub Actions only, each separating implemented / locally tested / CI verified / visually inspected / device verified / outstanding. Notably, Phase 8's first commit failed the Admin job and was verified green only on its follow-up commit. Recorded the Phase 10 merge SHA. Corrected the obsolete "rolling-window limits not implemented" sentence in `CLAUDE.md` (Phase 8 evidence: ADR-023, enforcement in `eligibility.service.ts`, CI green on `08eafbc`).

## Notes for the next game phase
Read from the code on `main` (no change made). These are platform gaps a future
game may hit; each would need its own ADR:
- `ChallengesService` is strictly two-party (`challengerId` / `opponentId`).
- Resignation (`MatchesService.submitCommand`) and turn-timeout (`MatchTimeoutService.processTurnTimeout`) pick "the opponent" with `findFirst({ userId: { not } })` — wrong for more than two players; `Match.winnerUserId` is single-valued.
- Match state is returned unredacted to every participant (`toMatchResponse` takes no viewer), so a game with simultaneous hidden choices (e.g. a penalty shoot-out) needs per-viewer redaction first.
- Matchmaking (`game.minPlayers`) and settlement (`computeWinSettlement` over `playerUserIds`) are already N-player capable.

## Evidence by level

| Level | Status | Evidence |
|---|---|---|
| **Implemented** | Yes | Shared-widget wrap fixes, the audit/regression tests, the three phase reports, doc corrections. |
| **Locally tested** | Yes (mobile) | `dart format --set-exit-if-changed .` clean over 126 files; `flutter analyze` — no issues; `flutter test` — 245 passed (183 existing + 62 new: the 60-case matrix and 2 geometry tests), run with the pinned Flutter 3.44.4 / Dart 3.12.2. No backend or admin code changed. |
| **CI verified** | Yes, on `7a991a5` | PR #2, run [39256886098](https://github.com/Ahmed004-art/playLe/actions/runs/39256886098) on head `7a991a5bc51b06a54056bab46b041a95e97c9049`: Backend (api) success (migrations, lint, typecheck, format, unit + Postgres/Redis e2e, build); Admin success (lint, typecheck, format, tests, build); Mobile (Flutter) success (format, analyze, tests, Android debug build). Every step green, no failure annotations. Any later commit on the PR branch changes only documentation; its own CI result is on the PR's checks, not asserted here. **Note:** the documentation-only commit `d510f26` had one intermittent Backend e2e failure (run 39258189645, `match-stakes.e2e-spec.ts:347`) on code identical to the passing run. Its cause is **still unproven** (the logs were never accessible). Investigating it did uncover a separate, real recovery gap — a one-sided `PENDING` stake on a cancelled match was never retried by crash recovery — which **PR #3 fixed** (merge commit `7f71c75`; `OUTSTANDING_WORK.md` item 26). Whether that gap or a pre-existing parallel-sweep test race caused the `d510f26` failure is not established. |
| **Visually inspected** | Chrome preview only | Real `DiceScreen`/`AppTheme` rendered headlessly at 320×640 and 390×844, Arial in place of Roboto, fixture data. Inspected after the final change (all six images viewed): opponent-turn with countdown, disconnected, and staked states at both widths — full-width bar, no clipping. **Only the Dice screen was rendered**: the Checkers and Tic-Tac-Toe screens, which share the changed widgets, are covered by the widget-test matrix only and were not visually inspected. |
| **Verified on a device** | **No** | No Android device or emulator. |

## Outstanding / blocked
- Android device/emulator verification and animation review (item 22) — **still open**; widget tests and the Chrome preview do not close it.
- Large-system-font behavior on a real device — **still open**; Phase 11 added widget-level 1.5× / 2× tests only.
- The 8 `npm audit` findings (item 23) — dispositioned above, not fixed.
- Item 26, residual — the recovery gap is fixed (PR #3), but the cause of the `d510f26` CI failure is unproven, and other timing-dependent e2e tests (including the Phase 10 Dice e2e) share the same parallel-sweep race class.
- Legal and payment-provider eligibility for real-money games of chance (items 3, 20, 21) and every earlier-phase blocker — unchanged.
