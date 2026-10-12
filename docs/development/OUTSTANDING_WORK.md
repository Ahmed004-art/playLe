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

### 7. Rolling-window spend tracking and loss-limit enforcement at settlement
**Status**: Not implemented — a documented simplification, not an
oversight. **Evidence**: ADR-021 "Amount limits are per-action
ceilings, not rolling-period sums"; `LOSS_LIMIT` is recorded/visible via
`GET /auth/responsible-gaming/status` but not enforced anywhere.
**Severity**: Medium — relevant to real-money launch readiness, not to
anything currently running (real-money gaming itself stays disabled by
default — see #9). **Owner**: a future, explicitly-scoped phase.

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

### 13. No turn/move timer
**Status**: Not implemented — identified during the Phase 7 audit, not
a Checkers-specific gap (applies equally to Tic-Tac-Toe). A connected
player who simply never moves can hold an `ACTIVE` match (and any held
stake) indefinitely; only a *disconnect* triggers the existing
abandonment grace-period forfeit. **Severity**: Medium for a staked
match's UX (not a financial-integrity issue — funds stay correctly held,
never lost or duplicated). **Owner**: a future, explicitly-scoped phase.

### 14. Matchmaking's "already in a match" check ignores `WAITING`
**Status**: Not implemented — identified during the Phase 7 audit, a
pre-existing platform gap. `MatchmakingService.join` only checks for an
existing *ACTIVE* match before queuing, not a `WAITING` one (e.g. a
staked match still waiting on stake confirmation). **Severity**: Low —
free-play matches skip `WAITING` entirely (they start `ACTIVE`
immediately), so this only matters for a staked match mid-stake-
confirmation, a narrow window. **Owner**: a future, explicitly-scoped
phase.

### 15. `match-timeout.service.ts`'s own doc comment is stale
**Status**: Not implemented — identified during the Phase 7 audit. The
class comment says an expired `WAITING` match is "currently unreachable
in practice", but a staked match genuinely does start `WAITING` and can
genuinely expire (see `MatchesService.createMatch`). Cosmetic only — the
sweep logic itself is correct and tested. **Severity**: Negligible
(documentation accuracy only). **Owner**: whoever next touches that
file; not worth a dedicated change on its own.

## Game platform (from Phase 7)

### 16. `GameResult` is binary (winner-or-draw, no reason)
**Status**: Unchanged from Phase 4/ADR-015; confirmed during the Phase
7 audit while implementing Checkers. A richer result (e.g.
"no-legal-move" vs. "no-remaining-pieces" vs. a future resignation)
would need an addition to the shared `GameResult` type or a
module-specific field inside `state`. Checkers currently encodes its own
finer-grained reasoning only inside its own state, not in the shared
contract. **Severity**: Low — doesn't block anything; a future game
needing richer result semantics can extend `GameResult` additively.
**Owner**: a future phase, if a game actually needs it.

### 17. No resign or draw-offer command type
**Status**: Not implemented. `MatchCommand.type` is hard-coded `'MOVE'`
throughout `MatchesService`. A resign/draw-offer flow would need either
a new command type or an in-payload convention (e.g. `{type: 'resign'}`)
that a game module's `validateMove`/`applyMove` interprets — the opaque
`@IsObject()` payload DTO already allows this without a schema change.
**Severity**: Low — a UX nicety, not a correctness gap. **Owner**: a
future phase.

---

This file is updated whenever a phase's audit or implementation work
surfaces a new durable item, or resolves an existing one with evidence.
See the current phase's own report for what that phase specifically
did; this file is the accumulated cross-phase picture.
