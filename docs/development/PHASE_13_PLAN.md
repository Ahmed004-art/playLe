# Phase 13 - Integration and reliability

## PR 1 - Integration verification and regression fixes

Baseline: branched from `origin/main`. Phase 12 PR 5 (mobile friends screens)
was still an open PR (#19) at the time, so this branch does not contain it.

### Confirmed defects and fixes

1. **No in-session token refresh (mobile).** The access token lives 15 minutes
   and the app refreshed only when restoring a saved session at start-up, so a
   session used longer than that failed every request with 401 until restart.
   Fix: `SessionRefresher` (single-flight, because the API rotates refresh
   tokens and treats reuse as theft) plus a retry-once 401 interceptor in
   `ApiClient`. A refused refresh clears tokens and signs the user out
   (`AuthController.sessionExpired`); a transient failure keeps the session.
   Auth endpoints other than `/auth/me` are never refreshed on 401.
   Tests: `test/core/auth/session_refresh_test.dart`.
2. **Named throttlers applied to every route (API).** `@nestjs/throttler`
   applies every registered named throttler to every route, so `auth`
   (5/min in production), `payments`, `matches` and `stakes` also capped
   ordinary reads, webhooks and admin actions. Fix: `optInThrottleSkipIf`
   makes each throttler apply only to routes carrying `@Throttle({name: {}})`.
   Routes that were previously limited only by accident but are sensitive
   (`change-password`, `auth/refresh`, `mfa/enroll`, admin `refresh`,
   withdrawal cancel, challenge decline/cancel, matchmaking leave) now carry an
   explicit decorator. Test: `src/common/opt-in-throttle.spec.ts` (real guard).

### Throttle policy (reviewed)
`src/common/throttle-policy.spec.ts` reads the real controllers and pins which
routes carry which opt-in limit. Sensitive routes keep an explicit limit:
`auth` for register/login/MFA verify/refresh/change-password/MFA enroll,
confirm and disable/admin login, MFA verify and refresh; `matches` for
challenge create/accept/decline/cancel, matchmaking join/leave, match command
and stake confirm; `payments` for deposit and withdrawal creation and
withdrawal cancel. Reads, `logout` and the Monime webhook intentionally use the
default limit only (the webhook contract says a valid sender must not be pushed
into a retry storm; a stricter or exempt policy for it is a decision not made
here). Admin finance mutations, session revoke and responsible-gaming limit
routes are authenticated and also on the default limit only; they were
previously limited only by the accidental global application.
`auth/me` is the one `/auth/*` route the mobile client refreshes on 401.
Mobile start-up no longer has its own refresh: `HttpAuthRepository.loadSession`
relies on the single-flight `SessionRefresher` via `ApiClient`.

### Decisions (owner, Phase 13 PR 1 review)
- The Monime webhook stays on the **default** limit; it is not exempt. It
  verifies the signature first (401 and nothing processed if it fails), records
  each delivery in `ProviderEvent` (unique provider + event id, so a duplicate
  is ignored by the database constraint) and answers 200 to every authenticated
  delivery.
- Admin finance mutations stay on the default limit in this PR.
- **Follow-up (not in this PR):** stricter, operation-specific throttling for
  admin finance mutations (wallet adjustments, withdrawal approve/reject/
  complete/fail) and a deliberate policy for webhook bursts.
- Phase 12 PR 5 (#19) was still open: this branch does not include the mobile
  friends screens or `ApiClient.delete`.

### Not changed / open
- Webhook, admin finance and other previously accidentally-throttled routes are
  now governed by the default limit only.
- Random matchmaking still ignores blocks (documented Phase 12 scope).
- Database-backed e2e suites run only in CI; nothing is device-verified.

## PR 2 - Recoverable webhook processing failures

### Confirmed defects
1. **A webhook whose processing failed after its `ProviderEvent` was stored
   was lost.** The event row (`RECEIVED`) is written before the money
   transaction. If that transaction (or the final status update) threw, the
   provider got a 500 and retried, but the retry hit the unique
   `(provider, providerEventId)` index and was answered 200 as a duplicate.
   A paid deposit stayed `PENDING`, a payout stayed `PROCESSING`, and nothing
   (code or reconciliation) looked at `RECEIVED` events.
2. **Withdrawal terminal outcomes were not claimed.** Provider completion/
   failure and admin `complete`/`fail` checked the status outside their
   transaction and then updated unconditionally, so two concurrent terminal
   outcomes (e.g. `payout.completed` and `payout.failed`) could both write
   the ledger - a payout completed *and* its hold released - whenever the
   held balance covered both.

### Design
- `payments/provider-events.ts`: `recordProviderEvent` stores the event, and
  on a duplicate returns the stored row for processing only if it is still
  `RECEIVED` **and** its event type and payload equal the redelivery
  (compared as stored JSON, key order ignored). A finished event, or one
  redelivered with different content, is ignored as before.
  `finishProviderEvent` moves an event out of `RECEIVED` only (conditional),
  never over a final status.
- Withdrawals: `claimFinal` locks the wallet (keeping the existing
  wallet-then-withdrawal lock order), then moves the withdrawal to its
  terminal status with `updateMany ... WHERE status IN (APPROVED,
  PROCESSING)` inside the money transaction. Only the winner writes the ledger
  and notifies; a provider-side loser returns the row unchanged, an admin
  loser gets the usual 409. Deposits already worked this way.
- Re-running a recovered event is safe because every money step is such a
  claim: a re-run, a re-run concurrent with a slow first attempt, or a re-run
  after the money committed but before the event was finished applies no
  second effect and just finishes the event.
- No schema change, no migration, no change to amounts, fees, ledger entry
  types, signature verification or the Monime provider.

### Deferred
- A reconciliation anomaly for `RECEIVED` events older than a threshold
  (needs a new anomaly type and a migration). Until then an event is
  recovered only if the provider redelivers it.
- A redelivery whose content differs from the stored unfinished event is
  logged and left `RECEIVED` for an operator.
- `approve` vs `cancel`/`reject` on a `PENDING_REVIEW` withdrawal has the same
  check-outside-the-transaction shape; not a terminal-outcome path, so not
  changed here.

### Verification
Unit: `provider-events.spec.ts`, `deposits.webhook-recovery.spec.ts`,
`withdrawals.terminal.spec.ts` (in-memory database model with per-transaction
rollback and atomic claims), plus the existing deposit webhook specs.
Database-backed: three new cases in `test/payments-phase6.e2e-spec.ts`
(deposit and payout recovery after an injected ledger failure; concurrent
`payout.completed`/`payout.failed`). **Those run only in CI** - there is no
local Postgres - and are unverified until CI runs them.

## PR 3 - Stale provider-event visibility

### Gap
PR 2 recovers an unfinished (`RECEIVED`) event when the provider redelivers the
same content. Nothing reported one that is never redelivered, or redelivered
with different content (acknowledged, never processed, left `RECEIVED`).

### Change (detection only)
- `PaymentReconciliationService.findStaleReceivedEvents`, part of `runOnce`:
  selects `status = RECEIVED AND createdAt < now - threshold` (strict, so an
  event exactly at the threshold is not yet reported). Recent and final-status
  events are never selected.
- Threshold `PROVIDER_EVENT_STALE_AFTER_MS`: default 15 min, validated
  5 min .. 45 min (`payments/reconciliation.constants.ts`). The floor is 20x the
  longest a money transaction can run (maxWait 5 s + timeout 10 s), so an event
  still being processed is not reported; the ceiling is under the 60-minute
  stuck-withdrawal threshold.
- New anomaly type `STALE_PROVIDER_EVENT` (one additive enum migration, no new
  table). Related deposit/withdrawal is derived from the stored payload's
  `providerReference` (payout events look at withdrawals, others at deposits).
- Dedupe (existing rule: an OPEN anomaly with the same type and related ids).
  That rule alone would fold every unmatched event into one anomaly, because
  their related ids are both null, so unmatched events also carry
  `details.eventKey = provider/providerEventId` and the lookup adds a Prisma JSON
  path filter on it. Events that match a record are one anomaly per record,
  naming every stale event.
- A conflicting redelivery needs nothing extra: it leaves the event `RECEIVED`
  with its original payload, so it is reported like any stale event.
- Nothing is credited, refunded, completed, failed or reprocessed. No scheduler,
  no admin UI (the existing payment-reconciliation API surfaces the anomalies).

### Verification
Unit: `payment-reconciliation.stale-events.spec.ts` (selection, exact boundary,
related-record matching, unmatched dedupe, repeat runs, resolved-then-still-stale,
finished events), `env.validation.spec.ts` (default and bounds), the existing
reconciliation spec. Database-backed (`test/payments-phase6.e2e-spec.ts`, **CI
only**): injected failure, back-dated event, reported once, no money or status
change, recovery stops the reporting, recent events not reported, resolved
anomaly re-raised, conflicting redelivery visible with payload unchanged,
unmatched events tracked independently via the JSON-path lookup, non-admin 403.