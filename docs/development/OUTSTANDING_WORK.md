# Outstanding Work Register

The durable, project-wide record of work that is known to remain
unfinished, deliberately deferred, or owner-dependent — across phases,
not just the current one. A phase's own report (e.g.
`PHASE_6_CHECKLIST.md`, the Phase 7 report) records what that phase
itself did; this file is where an item goes once it's no longer "this
phase's problem" but still isn't resolved. **Never delete an entry
because it stopped being someone's focus — close it only with evidence
it was actually fixed**, and record that evidence (a commit, a test, an
owner confirmation) inline.

Each entry: current status, evidence, dependencies, severity, and the
phase/owner responsible for resolving it.

## Payments / Monime (from Phase 6)

### 1. Webhook signature verification — blocked
**Status**: Blocked (external). **Evidence**:
`MonimeProvider.verifyWebhookSignature` (`apps/api/src/payments/providers/monime.provider.ts`)
always returns invalid; `monime.provider.spec.ts` asserts this
explicitly. The algorithm (HMAC-SHA256) is confirmed via the official
OpenAPI schema's `verificationMethod.hmac256` field, but the exact
canonical string it signs is not independently verifiable from any
source reached during Phase 6 or Phase 7. **Dependency**: owner action 3
in `docs/development/MONIME_SETUP.md` (capture a real webhook delivery
or the rendered HMAC-verification guide page). **Severity**: High for
production (blocks any automatic live deposit/payout confirmation); zero
impact on test-mode/local behavior, which is intentionally fail-closed.
**Owner**: project owner, pre-launch.

### 2. Webhooks must stay fail-closed until #1 is resolved
**Status**: Enforced, by design — not a gap to close on its own, a
constraint on closing #1 correctly. **Evidence**: same as #1.
**Severity**: N/A (this is the safe-default policy itself).

### 3. Monime business-model eligibility — unconfirmed
**Status**: Blocked (external/legal). **Evidence**:
`docs/development/MONIME_SETUP.md` action 1. **Dependency**: owner
contacts Monime support/sales. **Severity**: High — if Monime's terms
don't permit a real-money competitive-gaming merchant, that's a
business blocker independent of any code. **Owner**: project owner,
pre-launch.

### 4. Real Space credentials / token permissions / production activation
**Status**: Not started (owner-dependent, by design). **Evidence**:
`MONIME_API_KEY`/`MONIME_SPACE_ID` unset in any real deployment;
`MONIME_LIVE_PAYMENTS_ENABLED` defaults `false`
(`apps/api/.env.example`). **Severity**: N/A until the owner decides to
go live. **Owner**: project owner.

### 5. Payout destination field names — confirmed from docs, not from a real payout
**Status**: Implemented against the current (`caph-2025-08-23`)
documented schema; **not yet confirmed** against one real test payout.
**Evidence**: `docs/development/MONIME_SETUP.md` action 5 — an older
spec version used different field names, so this is flagged for
reconfirmation specifically, not assumed stable forever. **Severity**:
Medium — wrong field names would surface immediately as a provider
`400`/`UNAVAILABLE`, never a silent misrouted payout (the provider
refuses any destination shape it doesn't recognize exactly). **Owner**:
project owner, before any real payout.

### 6. Real email/SMS delivery
**Status**: Not implemented. **Evidence**: `src/notifications/` has
only `FakeDeliveryAdapter`; no real provider credentials exist.
**Dependency**: owner supplies credentials for a real provider.
**Severity**: Low for correctness (the OTP/notification *logic* is fully
implemented and tested — see ADR-020), blocking only for anything that
needs a message to actually reach a real inbox/phone. **Owner**: project
owner.

## Responsible gaming / eligibility (from Phase 6)

### 7. Rolling-window spend tracking and loss-limit enforcement at settlement — closed in Phase 8
**Status**: Implemented and enforced. **Evidence**: ADR-023
"Server-Enforced Rolling-Window Spending & Loss Limits";
`EligibilityService.assertCanStake`/`assertCanDeposit` now run real
rolling-window checks (`STAKE_LIMIT`/`DEPOSIT_LIMIT`/`LOSS_LIMIT`), called
from inside `MatchStakesService.confirmStake`'s transaction (after the
existing wallet row lock — see ADR-023 "Enforcement point") and from
`DepositsService.create`. `ChallengesService.accept` also now checks the
*opponent's* eligibility, closing a real pre-existing gap found during
the Phase 8 audit (a self-excluded/over-limit opponent could previously
accept an incoming staked challenge unchecked). Covered by
`test/responsible-gaming-limits.e2e-spec.ts` (12 tests, real Postgres,
including a genuine double-`settle()` call proving no double-counting on
retry) and `eligibility.service.spec.ts` (16 unit tests); both passing
locally and verified green in CI (see the Phase 8 report for the commit
SHA and run URL). **Residual limitation, not closed by this item**: see
#18 below — the `DEPOSIT_LIMIT` rolling check has a documented,
accepted concurrency gap specific to async provider-webhook completion.
**Severity**: N/A (implemented, tested, verified). **Owner**: N/A.

### 8. Self-exclusion has no lift path — by design, preserved
**Status**: Intentional, permanent, verified unchanged. **Evidence**:
grep for any lift/unlift method across `src/eligibility/` and every
admin controller finds none (checked again during the Phase 7 audit —
unchanged from Phase 6); ADR-021 "Self-exclusion: permanent, with no
lift path anywhere". **Do not close this item by adding a lift path**
without a separately-approved, carefully designed compliance process —
see ADR-021's "Alternatives Considered". **Severity**: N/A (this is the
correct, verified state). **Owner**: N/A unless a compliance-officer
process is separately approved.

### 9. Two independent real-money activation flags — verified still independent
**Status**: Verified correct as of Phase 7's audit. **Evidence**:
`REAL_MONEY_GAMING_ENABLED` and `ELIGIBILITY_POLICY_CONFIGURED` both
default `false` in `apps/api/src/config/env.validation.ts`; both are
checked independently in `EligibilityService`
(`src/eligibility/eligibility.service.ts`); CI sets both `true` only to
exercise the engine against test wallets (see the comment in
`.github/workflows/ci.yml`). **Severity**: N/A (verified healthy).

### 10. Production activation requires a real security/financial/operational review
**Status**: Not started — out of scope for any implementation phase by
definition; this is a human review, not code. **Severity**: High before
any real launch. **Owner**: project owner.

## Verification / engineering (from Phase 6, re-verified in Phase 7)

### 11. Local e2e tests requiring Redis
**Status**: Verified still accurate. As of the Phase 7 audit: 15 backend
e2e spec files; `matchmaking.e2e-spec.ts` explicitly guards itself with
an "is Redis reachable" precondition and throws/skips its whole suite
locally when it isn't (this sandbox has no Redis installed — a
pre-existing, documented local-only limitation). CI's real Redis service
container exercises this suite for real on every push; a real GitHub
Actions run is always the authority on whether it actually passes, not
a local skip. **Severity**: N/A locally; verified passing in CI.

### 12. Two real pre-existing race conditions found during the Phase 7 audit — fixed
**Status**: Fixed in Phase 7, unrelated to Checkers itself.
1. `MatchTimeoutService.expireWaitingMatches`/`expireChallenges` ran a
   bulk `updateMany` keyed only on `id`, with no `status` guard —
   unlike every other conditional transition in the codebase. A
   match/challenge that transitioned in the narrow window between the
   sweep's read and write could be wrongly overwritten. Fixed by making
   each transition a per-row, status-conditioned `updateMany` (mirroring
   `abandonDisconnectedMatches`'s existing pattern), so a row that
   already moved on is left alone and the follow-up settlement/emit only
   fires for a row this tick actually transitioned.
2. `ChallengesService.accept` emitted `challenge:resolved` *inside* the
   transaction callback, before commit. Fixed by moving the emit to
   after the transaction resolves.

Both fixed and reverified against the existing `matches.e2e-spec.ts`/
`match-stakes.e2e-spec.ts`/`realtime.e2e-spec.ts` suites (47 tests, all
passing) before any Checkers-specific work began. See the Phase 7
report for commit details.

### 13. No turn/move timer — closed in Phase 9
**Status**: Implemented and enforced. **Evidence**: ADR-024
"Server-authoritative turn timers". `Game.turnTimeoutSeconds` (a
per-game catalog value, both seeded games set to 60s) drives
`Match.turnDeadlineAt`, refreshed on every accepted move (including each
step of a Checkers multi-jump continuation) and checked by
`MatchTimeoutService.expireTimedOutTurns`/`processTurnTimeout`, which
locks the same `Match` row `MatchesService.submitCommand` already locks
— so a move racing a timeout can never both win, and the mechanism is
multi-instance-safe and restart-safe by construction (the deadline is a
real column, not an in-memory timer). Covered by
`test/match-lifecycle.e2e-spec.ts` (expiry, race-with-a-real-move,
duplicate-processing idempotency, deadline refresh) and
`test/checkers.e2e-spec.ts` (multi-jump preserves/bounds the timer
correctly) — both passing locally against real Postgres; verified in
CI. **Severity**: N/A (implemented, tested, verified). **Owner**: N/A.

### 14. Matchmaking's "already in a match" check ignores `WAITING` — closed in Phase 9
**Status**: Implemented and enforced. **Evidence**: ADR-024
"Duplicate-match prevention". `MatchmakingService.join`'s advisory check
now includes `WAITING`/`READY`, not just `ACTIVE`; the authoritative
guard is a new `MatchesService.createMatchGuarded` (sorted Postgres
advisory transaction locks per involved user, then a conflict check,
then the match creation — all in one transaction), used by both
matchmaking's post-pop step and `ChallengesService.accept`, closing the
race between two concurrent match-forming attempts sharing a user
(previously possible across matchmaking and challenge-accept, or two
concurrent challenge-accepts). Covered by
`test/match-lifecycle.e2e-spec.ts` (concurrent challenge-accepts sharing
a user; the WAITING-blind case) and `test/matchmaking.e2e-spec.ts`
(real-Redis stale-queue-recovery test — a popped-but-conflicting user is
excluded, a popped-and-still-free user is safely re-queued, not
dropped). **Severity**: N/A (implemented, tested; the Redis-dependent
test is verified in CI only — see item 11). **Owner**: N/A.

### 15. `match-timeout.service.ts`'s own doc comment is stale — closed in Phase 9
**Status**: Fixed. **Evidence**: the class doc comment no longer claims
an expired `WAITING` match is "currently unreachable in practice" — it
now accurately states a staked match genuinely reaches and can expire
from `WAITING` (unchanged logic; this was always a real, tested path).
**Severity**: N/A. **Owner**: N/A.

## Game platform (from Phase 7, substantially addressed in Phase 9)

### 16. `GameResult` is binary (winner-or-draw, no reason) — substantially addressed in Phase 9
**Status**: The platform-level complaint (no way to represent
resignation/timeout/agreed-draw *anywhere* in the shared contract) is
closed. **Evidence**: ADR-024 "Terminal-outcome semantics: extend
`MatchTerminationReason`, not `GameResult`" — `MatchTerminationReason`
gained `RESIGNATION`/`TURN_TIMEOUT`/`DRAW_AGREED`, which combined with
the pre-existing `winnerUserId`/`resultIsDraw` now distinguishes every
outcome required (normal win, board draw, resignation, timeout,
disconnect forfeit, stake-commit cancellation, agreed draw) without
touching the `GameModule`-facing `GameResult` interface itself — a
deliberate choice, since `SettlementService` and both game modules
needed zero changes. **Remaining, narrower nuance, deliberately not
addressed**: Checkers' own internal distinction between "no legal move"
and "no remaining pieces" still lives only in its private state, not in
the shared contract — unchanged from Phase 7, genuinely optional future
work if a game ever needs to expose it beyond its own state.
**Severity**: Low (the narrow remainder). **Owner**: a future phase, if
a game actually needs it.

### 17. No resign or draw-offer command type — closed in Phase 9
**Status**: Implemented. **Evidence**: ADR-024 "Resign and draw offers".
`MatchCommand.type` now accepts `RESIGN`/`DRAW_OFFER`/`DRAW_ACCEPT`/
`DRAW_REJECT` alongside `MOVE` (no schema change was needed — `type` was
already a free-form column), all processed inside the exact same
row-locked transaction as a move. New `Match.pendingDrawOfferByUserId`/
`pendingDrawOfferExpiresAt` columns; new `GameModule.supportsResignation`/
`supportsDraws` capability flags (both true for Tic-Tac-Toe and
Checkers). Mobile UI: `MatchActionBar`/`DrawOfferBanner` (new shared
widgets under `core/match/widgets/`, reusing the Phase 7 design system),
wired into both `TicTacToeScreen` and `CheckersScreen`. Covered by 8 new
backend e2e tests (idempotent resign, non-participant rejection, late
resignation not overwriting a real result, draw offer/accept/reject,
self-accept rejection, duplicate-offer rejection, expiry, implicit
withdrawal via a move) and 8 new mobile widget tests — all passing.
**Severity**: N/A (implemented, tested, verified). **Owner**: N/A.

## Responsible gaming / eligibility (from Phase 8)

### 18. `DEPOSIT_LIMIT` rolling check has no wallet-lock-equivalent concurrency guarantee
**Status**: Accepted, documented limitation — not a bug, and not
something Phase 8 attempted to fully close. **Evidence**: ADR-023
"Deposit-limit rolling check: a documented, accepted concurrency
limitation". Deposit completion is driven by an asynchronous Monime
webhook, so — unlike a stake confirmation, which holds the user's wallet
row lock for the whole eligibility check — there is no request in flight
at the moment a deposit actually completes against which a lock could be
held. The check still correctly blocks *initiating* a new deposit once
the rolling sum of already-**completed** deposits would exceed the
limit; it just cannot guarantee two deposits racing through completion
at the same instant can never together exceed the limit by a small
margin. **Severity**: Low — bounded by the per-deposit maximum, and
real-money gaming/deposits stay disabled by default regardless (see #9).
**Owner**: a future phase, only if a stronger guarantee is ever required
(e.g. by re-checking the rolling sum again inside the webhook-completion
transaction itself and reversing/flagging an over-limit completion after
the fact).

### 19. Rolling-window length is a fixed platform parameter, not user-configurable — by design, preserved
**Status**: Intentional, verified as implemented. **Evidence**: ADR-023
"The rolling window is a fixed platform parameter, not user-configurable";
`RESPONSIBLE_GAMING_WINDOW_HOURS` lives in server config, not on
`ResponsibleGamingRestriction`, and has no corresponding user-facing
control. **Do not close this item by adding a per-user window** without
re-deriving why that would reopen the "shrink your own window to evade a
limit" bypass ADR-023 closes. **Severity**: N/A (correct, verified
state). **Owner**: N/A.

## Game platform / launch readiness (from Phase 10)

### 20. Dice real-money launch is not authorized — owner/legal decision
**Status**: Blocked (external/legal). **Evidence**: ADR-025
"Implementing versus launching"; the Dice seed migration
(`20261019120000_seed_dice_game`) inserts the catalog row with
`enabled = false`. Dice is a pure game of chance, unlike Tic-Tac-Toe and
Checkers. Whether real-money games of chance are lawful for PlayLe's
intended operation, and whether the payment provider's merchant terms
permit them, are unconfirmed — Phase 10 neither answers nor assumes
either (see also #3). **Dependency**: owner obtains legal and
payment-provider confirmation; separately decides when to enable the
`dice` catalog row (a deliberate catalog change — no tooling was added
for it in Phase 10). **Severity**: High before any enabling, especially
for real money; no impact while the game stays disabled. **Owner**:
project owner, pre-launch.

### 21. Dice outcomes are not independently verifiable — accepted limitation
**Status**: Accepted, documented. **Evidence**: ADR-025 "Fairness
limitations". Rolls come from a server-side CSPRNG
(`crypto.randomInt`); there is no commit-reveal or other verifiable-
randomness protocol, so players must trust PlayLe. Dice must never be
described as "provably fair" in the UI or in marketing. A commit-reveal
scheme would be a separate design (own ADR) and phase. **Severity**:
Medium for trust/regulatory perception; Low for correctness. **Owner**: a
future phase, only if verifiability becomes a requirement.

### 22. Dice mobile UI has not been visually verified on a real device
**Status**: Open. **Evidence**: Phase 10 had no Flutter/Android tooling or
device available; widget tests verify behavior (turn states, server-
authoritative dice and results, reduced motion, small-screen layout) but
not visual quality. **Remaining steps**: run the debug build on an
Android device or emulator at a few screen sizes and with reduced motion
on; check die-face legibility and pip correctness, the roll interaction
and tumble animation, contrast, touch-target size, and the
waiting/rejected/timeout/resignation/win/loss/draw states; adjust
`apps/mobile/lib/features/dice/` if needed. **Severity**: Medium (product
quality is a first-class acceptance criterion). **Owner**: project owner
or whoever has a device.
**Phase 11 update (still OPEN)**: Phase 10 was merged (PR #1, merge commit
`d051115`) and CI-verified. Phase 10/11 added evidence from a **Chrome
preview** (the real `DiceScreen`/`AppTheme` rendered headlessly at 320×640
and 390×844 from fixture states, Arial standing in for Roboto) and widget
tests — neither is an Android device check, so the remaining steps above
are unchanged. Not yet seen at all: the roll/tumble animation in motion,
reduced-motion behavior on a device, and large system font sizes on a
device.

## Repository hygiene (found during Phase 10 environment recovery)

### 23. `npm audit` reports 8 high-severity findings — remediation not yet done
**Status**: Open; deliberately not remediated in Phase 10. **Evidence**:
two chains, both through devDependencies: `eslint-config-next` →
`@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces`
(stack-exhaustion DoS, GHSA-vfj7-8cjw-p6xm) in the admin app, and
`prisma` CLI → `@prisma/config` → `deepmerge-ts` (stack exhaustion,
GHSA-ggr8-5vv4-36mx) in the API. `npm audit`'s suggested "fixes" are a
downgrade (`eslint-config-next@14.2.35`) and a major upgrade
(`prisma@7.10.1`), so none was applied. **Severity**: Low-Medium (build/
CLI tooling processing no user input; exploitability untested). **Owner**:
a separate, controlled dependency-remediation task with CI.
**Phase 11 disposition (still OPEN, decision recommended — nothing was
changed)**: the audit was reproduced exactly (8 high, from two advisories).
- **GHSA-vfj7-8cjw-p6xm, `braces` ≤ 3.0.3 (5 findings: `braces`,
  `micromatch`, `fast-glob`, `@next/eslint-plugin-next`,
  `eslint-config-next`)**: the advisory lists **no patched version** and
  3.0.3 is the latest published, so no update or override can fix it.
  Exposure: glob patterns come from the ESLint plugin's static config while
  linting the repo's own files; nothing reaches it from a request. DoS-class
  (crash). **Recommendation**: accept; re-run `npm audit` on each dependency
  update and revisit when a patched release appears.
- **GHSA-ggr8-5vv4-36mx, `deepmerge-ts` < 8.0.0 (3 findings: `deepmerge-ts`,
  `@prisma/config`, `prisma`)**: patched in 8.0.0, but `@prisma/config`
  6.19.3 pins 7.1.5 exactly; only Prisma 7.x uses 8.x — a major upgrade not
  taken merely to clear an audit. A scoped `overrides` entry was tried in a
  scratch copy (scoped, global, and with `npm update`): npm 10.9.8 kept 7.1.5
  every time, and running npm on this lockfile rewrites 37 unrelated lines of
  metadata flags. Exposure: the repo has no `prisma.config`, so Prisma's
  config loader only merges its own defaults. **Recommendation**: accept
  until a dedicated Prisma 7 upgrade phase (with migration/e2e verification).
- Reasoning above is exposure analysis, not "it's only a dev dependency".
  Full detail: `PHASE_11_REPORT.md`, Stage 3.

### 24. No Phase 8 or Phase 9 report exists in `docs/development/`
**Status**: Open. **Evidence**: `CLAUDE.md` and `README.md` refer to "the
Phase 9 report" for exact test counts, verification results and the CI
run URL, but `docs/development/` only holds the Phase 6 and Phase 7
checklists. For Phase 9, a green CI run on commit
`085dfd3973582d2185405abf06c39f283ec9d926` was verified directly via the
GitHub API (run 38437718801: Admin, Backend and Mobile all succeeded).
**Severity**: Low (documentation gap). **Owner**: whoever next maintains
the phase documentation.
**Phase 11 update — CLOSED**: `PHASE_8_REPORT.md`, `PHASE_9_REPORT.md` and
`PHASE_10_REPORT.md` now exist (plus `PHASE_11_REPORT.md`), written only from
Git history and GitHub Actions data, each separating implemented / locally
tested / CI verified / visually inspected / device verified / outstanding.
Finding recorded there: Phase 8's first commit `1becc31` failed the Admin
job and was CI-verified green only on `08eafbc`. Where the repo's older
prose claimed local test passes, the reports say "claimed, not reproduced".

### 25. Shared match chrome may overflow on narrow screens — unverified on a device
**Status**: Open, pre-existing (not introduced by Phase 10). **Evidence**:
running the Dice widget tests at a 390 px phone viewport with Flutter's
test font (roughly twice as wide as a real font) produced `RenderFlex`
overflows in two *shared* widgets: `MatchStatusBar` (the "Opponent
disconnected" row, `core/match/widgets/match_status_bar.dart`) and
`MatchStakeStatusBar` (the entry/pool row). Checkers' tests avoid it only
because they run at the default 800 px width. Both widgets are fixed-size
rows with no flexible children, so they are the likeliest place for a real
overflow on a narrow phone, a large system font size, or a long countdown
string. Real-device impact is **not verified**; the test font exaggerates
it. Phase 10 worked around its own part (the Dice status-bar `leading` is
icon-only) and runs only those two tests at the default viewport.
**Severity**: Low-Medium (all games share these widgets). **Owner**: a
future UI-polish task: make both rows wrap or flex, then run every game
screen test at a phone-width viewport.
**Phase 11 update — fixed at the widget level; real-device check still OPEN
(see #22)**: `MatchStatusBar`, `MatchStakeStatusBar`, `DrawOfferBanner`,
`FinancialResultBanner` and the Dice roll rows now wrap or flex instead of
overflowing. Evidence: a new test matrix
(`apps/mobile/test/core/match/match_chrome_layout_test.dart`) at 320 and 390
px × 1.0/1.5/2.0× text scale covering the shared widgets and the Tic-Tac-Toe,
Checkers and Dice screens — 47 of its 60 cases failed before the fix and all
pass after; the two Dice tests moved to the wide viewport now run at phone
width again; a geometry test (verified to fail without its fix) guards the
status bar spanning the full width; a Chrome preview re-render of the
**Dice screen only** confirmed no visual regression at normal sizes (the
Checkers and Tic-Tac-Toe screens share these widgets but were covered by the
widget matrix only, not rendered). The test font is ~2× wider than a real
one, so this is a stricter bar than a device, but it is not a device check.

---

This file is updated whenever a phase's audit or implementation work
surfaces a new durable item, or resolves an existing one with evidence.
See the current phase's own report for what that phase specifically
did; this file is the accumulated cross-phase picture.
