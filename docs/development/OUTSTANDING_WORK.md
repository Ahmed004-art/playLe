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

---

This file is updated whenever a phase's audit or implementation work
surfaces a new durable item, or resolves an existing one with evidence.
See the current phase's own report for what that phase specifically
did; this file is the accumulated cross-phase picture.
