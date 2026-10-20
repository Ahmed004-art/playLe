# Phase 8 Report — Server-Enforced Rolling-Window Responsible Gaming

Written in Phase 11 from repository evidence (Git history, the code on
`main`, and GitHub Actions results). It deliberately does **not** restate
numbers that cannot be verified from those sources — where the repo's own
earlier prose makes a claim this report could not independently confirm, it
says so.

## Scope
Close outstanding-work item 7: enforce real rolling-window `STAKE_LIMIT`,
`DEPOSIT_LIMIT` and `LOSS_LIMIT` (previously a documented Phase 6
simplification). Design and rationale: [ADR-023](../decisions/ADR-023-rolling-window-responsible-gaming.md).

## Commits
| Commit | Date | What | Size |
|---|---|---|---|
| `1becc314eb1a89e73d15dbdab895cbdb966a870b` | 2026-10-13 | Phase 8 implementation | 37 files, +2847 / −114 |
| `08eafbc0e10cb264961631f84f272bb2560c99ab` | 2026-10-13 | Fix admin Prettier formatting in the Phase 8 files | 3 files, +8 / −16 |

## Evidence by level

| Level | Status | Evidence |
|---|---|---|
| **Implemented** | Yes | `EligibilityService` enforces `STAKE_LIMIT`, `DEPOSIT_LIMIT` and `LOSS_LIMIT` (`apps/api/src/eligibility/eligibility.service.ts`, present on `main`). Enforcement points per ADR-023: `MatchStakesService.confirmStake` (inside the wallet-locked transaction) and `DepositsService.create`. `ChallengesService.accept` now also checks the *opponent's* eligibility (a gap the phase's audit found). Two schema migrations (rolling-window indexes; a limit-reached notification type). Admin read-only usage page and a mobile usage view. |
| **Locally tested** | Claimed, **not reproduced** | `OUTSTANDING_WORK.md` item 7 states the new suites passed locally. No local run of this phase's suites was performed in Phase 11, and no earlier artifact of one is in the repo. |
| **CI verified** | **Yes, on `08eafbc`** | The first commit `1becc31` (run [38357331169](https://github.com/Ahmed004-art/playLe/actions/runs/38357331169)): Backend success, Mobile success, **Admin failed**. The fix commit `08eafbc` (run [38364048424](https://github.com/Ahmed004-art/playLe/actions/runs/38364048424)): Admin, Backend and Mobile all success. Phase 8 is therefore CI-verified on `08eafbc`, **not** on `1becc31`. |
| **Visually inspected** | No evidence | No screenshots or visual review of the new admin/mobile usage views exist in the repo. |
| **Verified on a device** | No evidence | None recorded. |

## Tests added
Counted from the commits' diffs by matching `it(`/`test(`/`testWidgets(`
declarations on added lines (a count of *declared* tests, not of passing
results; `it.each` rows count once):

| File | Declarations |
|---|---|
| `apps/api/src/eligibility/eligibility.service.spec.ts` | 10 |
| `apps/api/test/eligibility.e2e-spec.ts` | 4 |
| `apps/api/test/responsible-gaming-limits.e2e-spec.ts` | 12 |
| `apps/admin/src/app/responsible-gaming/page.test.tsx` | 3 |
| `apps/mobile/test/core/responsible_gaming/responsible_gaming_controller_test.dart` | 7 |
| `apps/mobile/test/features/auth/responsible_gaming_screen_test.dart` | 8 |
| **Total declarations** | **44** |

Pass counts per run are not recoverable from the API without log access;
none is claimed here.

## Outstanding / blocked
- `DEPOSIT_LIMIT` has an accepted concurrency limitation (`OUTSTANDING_WORK.md` item 18).
- The rolling-window length is a fixed platform parameter by design (item 19); self-exclusion has no lift path by design (item 8).
- Real-money gaming remains disabled by default and gated on legal/provider decisions (items 3, 9, 10).
