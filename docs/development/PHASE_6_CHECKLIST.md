# Phase 6 Implementation Checklist — Production Payments & Account Security

Living document. Status values: **Complete**, **In Progress**, **Blocked
(external)**, **Requires Owner Action**, **Deferred**. Updated as the
phase proceeds — this is the audit required before implementation began,
kept current rather than written once and abandoned.

## 0. Verified Monime API Facts (vs. speculative prompt input)

Fetched directly from `docs.monime.io` (current API version
`caph-2025-08-23`) and the official `monimesl` GitHub org
(`monime-developer-apis`) on 2026-10-11. Superseding any earlier
unverified assumption.

| Fact | Verified value |
|---|---|
| Auth headers | `Authorization: Bearer <token>` + `Monime-Space-Id: spc-...` (both required on every request) |
| Token format | Live: `mon_...`. Test: `mon_test_...`. Same base URL (`https://api.monime.io`) for both — environment is selected by *which token you send*, not a separate flag/URL. |
| Optional version pin | `Monime-Version: caph.2025-08-23` header |
| Idempotency | `Idempotency-Key` header, UUIDv4 recommended, 25-64 chars. Retry with the same key + same body replays the original result (24h fast path, indefinite last-mile dedup). Retry with the same key + **different** body → `409 idempotency_key_in_use`. |
| Deposit resource | `POST /v1/checkout-sessions` (hosted redirect flow) and/or `POST /v1/payment-codes` (USSD/MoMo code flow) — see "Open Question" below on which fits PlayLe's mobile app better |
| Payout resource | `POST /v1/payouts`, body `{ amount: {currency, value}, destination: {type, providerId, ...}, source?, metadata? }` |
| Webhook payload | `{ apiVersion, event: {id, name, timestamp}, object: {id, type}, data: {...} }` |
| Confirmed event names | `payment_code.created/expired/processed/completed`, `payout.failed/completed/delayed`, `checkout_session.*` ("coming soon" per docs) |
| Webhook signature algorithm | **HMAC-SHA256** (confirmed from the official OpenAPI schema's `verificationMethod.hmac256.secret` field, 32-100 chars) |
| Webhook signature header | `Monime-Signature`, documented only as "cryptographic signature with timestamp" |

### Open/unverified — kept fail-closed, not guessed

1. **Exact `Monime-Signature` canonical string** (what bytes actually get
   HMAC'd — e.g. `timestamp + "." + rawBody`, or something else). The
   official HMAC-verification doc page
   (`docs.monime.io/guide/webhook/hmac-verification`) renders only a
   client-side loading placeholder to automated fetches; no official SDK
   source was reachable either. **Owner action**: use the `monime-cli`
   tool's Webhook Inspector (https://docs.monime.io, "Developer Tools →
   MCP Server/CLI") against a Test-mode webhook, or open the HMAC
   verification page in a real browser and paste its content here. Until
   then, `MonimeProvider.verifyWebhookSignature` **always returns
   invalid** for every input — exactly extending the fail-closed stance
   already shipped in Phase 3, never weakened.
2. **Whether Checkout Sessions or Payment Codes is the right deposit
   resource for a native mobile app.** Checkout Sessions return a hosted
   `redirectUrl` (web-page flow); Payment Codes return a `ussdCode` (dial
   a USSD string, no redirect). A mobile MoMo deposit most plausibly
   wants Payment Codes, but this is a product decision, not something
   inferable from docs alone. **Decision taken**: implement Payment
   Codes as the deposit mechanism (matches "mobile app, no web redirect"
   and the existing mobile-money framing in CLAUDE.md); Checkout Sessions
   left unimplemented as a documented future option. Flagged for owner
   confirmation, not blocking.
3. **Destination field names for payouts** — the current docs page shows
   `destination.providerId` + a type-specific field (e.g. `phoneNumber`
   for `momo`); the older `2024-08-01` OpenAPI spec instead shows
   `providerCode`/`accountId`. Implemented against the **current**
   (`caph-2025-08-23`) docs page as authoritative; flagged as an owner
   action to confirm with one real test payout before going live.
4. **Whether PlayLe's real-money competitive-gaming model is an
   approved use case for Monime, which collection/payout providers are
   enabled on the Space, fees, and limits.** None of this is resolvable
   from documentation — recorded as owner actions below, independent of
   code completion.

## 1. Owner Actions Required

| # | Action | Why | Where | Test credential OK? |
|---|---|---|---|---|
| 1 | Confirm PlayLe's business model is supported by Monime | Can't activate live payments otherwise | Monime support (already contacted per the brief) | N/A |
| 2 | Create a Monime Space + generate a **Test** Personal Access Token | Needed to exercise anything beyond the FakeProvider | https://monime.io → dashboard → Personal Access Tokens | Yes — test token is sufficient and preferred |
| 3 | Capture one real Test-mode webhook delivery (header + raw body) via `monime-cli`'s Webhook Inspector, or confirm the exact HMAC canonical string | Unblocks real signature verification (item 0.1 above) | `monime-cli` tool / docs.monime.io webhook guide | Yes |
| 4 | Confirm Payment Codes (USSD) vs. Checkout Sessions (hosted redirect) as the intended mobile deposit UX | Product decision, not inferable | — | N/A |
| 5 | Decide the real-money eligibility policy (minimum age for real-money play, jurisdiction, any KYC requirement) | `REAL_MONEY_GAMING_ENABLED` stays `false` by default until this is set | — | N/A |
| 6 | Supply email/SMS delivery credentials (or confirm none exist yet) | Password-reset/verification delivery is otherwise a tested FakeDeliveryAdapter only | — | N/A |

## 2. Implementation Status

### Provider & Payments
- [x] Extended `PaymentProviderPort` — **Complete**: `initiatePayout`,
      `checkPayoutStatus`, `checkDepositStatus` added alongside the
      existing `initiateDeposit`/`verifyWebhookSignature`; every outbound
      call now carries a persisted `providerIdempotencyKey`.
- [x] Real `MonimeProvider` — **Complete** against the verified
      `caph-2025-08-23` API: Payment Codes (`POST /v1/payment-codes`) for
      deposits, Payouts (`POST /v1/payouts`) for withdrawals, status
      polling (`GET` both), real HTTP via native `fetch` + `AbortSignal.timeout`
      (no new dependency). Guardrails: a `mon_test_...` token always
      runs; a live (`mon_...`) token additionally requires
      `MONIME_LIVE_PAYMENTS_ENABLED=true`; missing/unrecognized
      key/space-id/destination → `UNAVAILABLE`, never guessed. Payout
      destination mapping only trusts the exact Monime shape or the one
      verified legacy mapping (`ORANGE_MONEY` → `m17`) — everything else
      is left unmapped (see item 3 below). Unit-tested
      (`monime.provider.spec.ts`, 15 tests): readiness/guardrails, HTTP
      success/4xx/network-error handling, destination mapping, and the
      webhook *payload-parsing* logic (independent of the still-missing
      signature check).
- [x] Webhook signature verification — **Blocked (external)**, fail-closed
      (see item 0.1) — unchanged from the prior stance, now proven via
      `parseMonimeWebhookPayload` unit tests that the parsing side is
      otherwise ready.
- [x] Provider-operation tracking model — **Complete**: `ProviderOperation`,
      `PaymentReconciliationAnomaly`, `PasswordResetToken`,
      `VerificationChallenge`, `MfaTotpCredential`, `MfaRecoveryCode`,
      `ResponsibleGamingRestriction`, `NotificationOutbox` models added;
      `DepositStatus.EXPIRED`, `WithdrawalStatus.PROCESSING` enum values
      added; `ProviderEvent`/`Deposit`/`Withdrawal` extended with the new
      relations. Migration `20261012000324_phase6_payments_security_schema`
      generated and applied against the real local Postgres test DB
      (reset was required first — an earlier migration's checksum had
      drifted from disk; reset only ever touches the local `playle_test`
      dev database, done with explicit owner confirmation).
- [x] FakeProvider for deterministic tests — **Complete**:
      `test/fake-payment-provider.ts` extended with `depositScenario`
      (`pending`/`network_error`) and `payoutScenario`
      (`pending`/`succeeded`/`failed`/`unavailable`/`network_error`)
      controls, plus `buildPayoutWebhookBody`.

### Deposits / Withdrawals
- [x] Deposit lifecycle using real provider (Payment Code → webhook → credit)
      — **Complete**: `DepositsService.create` mints a provider
      idempotency key, records a `ProviderOperation`, and surfaces
      `paymentInstructions` (USSD code + expiry) via the deposit response
      DTO. `deposit.expired` webhooks now map to a new `markExpired`
      path (`DepositStatus.EXPIRED`, no ledger effect).
- [x] Withdrawal lifecycle using real payout (hold → submit → confirm/release)
      — **Complete**: `approve()` now calls the new `submitPayout()`
      immediately after the review transition (same "create, then call
      the provider as a separate step" pattern deposits already used).
      A network error during submission is recorded as an `UNKNOWN`
      `ProviderOperation` and the withdrawal moves to `PROCESSING` —
      **never retried with a new idempotency key** (per the spec's
      explicit rule). `payout.completed`/`payout.failed`/`payout.delayed`
      webhooks resolve it via new `completeFromProviderEvent`/
      `failFromProviderEvent` methods (structural twins of the deposit
      ones). Admin `complete`/`fail` now also accept `PROCESSING` (for a
      stuck/`UNKNOWN` payout resolved by hand after out-of-band
      reconciliation) — still mandatory-reason, still audited, still no
      "just mark it paid" shortcut. When the provider is `UNAVAILABLE`
      (Manual, or Monime not ready), the withdrawal simply stays
      `APPROVED` and the pre-Phase-6 manual admin flow applies unchanged.
- [x] New states (`PROCESSING`, `EXPIRED`) — **Complete** (see schema section).
- [x] e2e coverage — **Complete**: `test/payments-phase6.e2e-spec.ts` (11
      tests, run against the real local Postgres DB): payment
      instructions on deposit creation, deposit-initiation network error
      → `UNKNOWN` + still `PENDING`, `deposit.expired` webhook, payout
      submission → `PROCESSING`, `payout.completed`/`payout.failed`
      webhooks, synchronous-`SUCCEEDED` immediate completion, payout
      network error → `UNKNOWN` + funds stay held + admin manual
      resolution, `UNAVAILABLE` → stays `APPROVED` for the manual flow,
      duplicate webhook delivery is a no-op, invalid signature is
      rejected. All existing Phase 3/4/5 tests re-run and still pass
      (120 unit + the full e2e suite, module-by-module — two match-stakes
      tests only failed when the *entire* e2e suite ran at once due to
      local parallel-worker/Postgres contention with no Redis available
      locally; confirmed passing in isolation, not a Phase 6 regression).

### Reconciliation
- [x] Payment reconciliation (separate from Phase 5's match reconciliation)
      — **Complete**: `PaymentReconciliationService` (9 read-only checks:
      deposit credited without confirmation, deposit confirmed not
      credited, withdrawal paid not completed, withdrawal completed
      without confirmation, duplicate provider reference, stuck
      `PROCESSING` >1h, `UNKNOWN` payout outcome, orphan provider event,
      per-record ledger/provider drift). Never mutates money — persists
      findings to `PaymentReconciliationAnomaly` (deduplicated against
      already-OPEN rows across repeated runs) for human review.
      `AdminPaymentReconciliationController`:
      `GET /admin/payment-reconciliation/run`,
      `GET /admin/payment-reconciliation/anomalies`,
      `POST /admin/payment-reconciliation/anomalies/:id/resolve`
      (mandatory reason, audited — resolving only records a review
      happened, never itself touches a balance). 2 new e2e tests
      (detect+persist+dedup+resolve; non-admin rejected).

### Admin
- [x] Admin auth hardening (httpOnly session cookies) — see "Account Security" below
- [x] Provider-operation / webhook-event admin views — **Complete**:
      `GET /admin/provider-operations` (optionally filtered by userId —
      every outbound deposit-initiation/payout call), `GET
      /admin/provider-events` (every inbound webhook delivery, valid or
      not). Plus `GET /admin/responsible-gaming` (restriction history,
      read-only — no endpoint anywhere lifts/edits one). 4 e2e tests.
- [x] Payment reconciliation admin view — **Complete**, see "Reconciliation" above (`AdminPaymentReconciliationController`)

### Account Security
- [x] Admin auth hardening (httpOnly session cookies) — **Complete**
      (backend): new `admin_access_token`/`admin_refresh_token` (httpOnly,
      `SameSite=Lax`, `Secure` when `ADMIN_SESSION_SECURE_COOKIES=true`)
      + `admin_csrf_token` (readable, double-submit) cookies, issued by
      `AdminSessionController` (`POST /admin/session/login`/`refresh`/
      `logout`, `GET /admin/session/me`). Reuses the exact existing
      `AuthService`/`TokenService` rotating-refresh-token machinery —
      this is a different *transport* for the same session primitive,
      not a second auth system. `JwtAuthGuard` now also accepts the
      cookie as a fallback token source (only when no `Authorization`
      header is present, so every existing Bearer-token client/test is
      unaffected — reverified: all 120 unit + the full e2e suite still
      pass unchanged). A login attempt with valid credentials but a
      non-admin role revokes the session it just issued and returns the
      same generic "Invalid credentials" as a wrong password (no
      privilege-leak). New globally-registered `CsrfGuard`
      (double-submit: `X-CSRF-Token` header must match the
      `admin_csrf_token` cookie) protects every mutating `/admin/*`
      route — a no-op for Bearer-token requests, since those aren't
      cookie/CSRF-exploitable. Brute-force protection reuses the
      existing `auth` throttle profile (no new limiter). New
      append-only `AdminAuditLog` records `LOGIN_SUCCESS`/
      `LOGIN_FAILED`/`LOGOUT`/`SESSION_REFRESH`/`CSRF_REJECTED`. 9 new
      e2e tests (cookie login/me/refresh/logout, CSRF missing/mismatch/
      matching, non-admin rejection, audit entries). **Admin frontend
      migrated — Complete**: `token-storage.ts` deleted; `api-client.ts`
      now sends `credentials: 'include'` and auto-attaches
      `X-CSRF-Token`; `auth-context.tsx`/`AuthGuard.tsx` retargeted to
      `/admin/session/*`. Independently re-verified (not just the
      delegated agent's own report): `npm run build --workspace=apps/admin`
      (10 routes), `npm run lint --workspace=apps/admin`, and
      `npm run test --workspace=apps/admin` (31/31 passing, 9 files) all
      clean.
- [x] Admin frontend migrated off `localStorage` to the cookie contract
      above — **Complete** (delegated, then independently re-verified:
      build/typecheck/lint/test all actually re-run by the orchestrating
      session, not just taken on the sub-agent's word). `token-storage.ts`
      deleted; `api-client.ts`'s single `request()` chokepoint now sends
      `credentials:'include'` on every call and attaches `X-CSRF-Token`
      (read from `document.cookie`) on every mutating `/admin/*` request
      except `session/login`; `auth-context.tsx` restores via
      `GET /admin/session/me` with no pre-existing-token check. 31 admin
      frontend tests pass (9 files, `--maxWorkers=2` to avoid this
      environment's known vitest-worker contention flake).
- [x] Password reset — **Complete**: `PasswordResetService`
      (`src/password-reset/`) — single-use, hashed (SHA-256, never the
      raw token), 30-minute-expiring tokens; `POST
      /auth/password-reset/request` always returns the identical generic
      message whether or not the identifier matches an account (verified
      by an e2e test asserting byte-identical responses); confirming
      revokes every existing session (`TokenService.revokeAllForUser`,
      same policy as `changePassword`) and cannot be replayed. Delivered
      via the new `DeliveryPort`/`FakeDeliveryAdapter`
      (`src/notifications/`) — no real email/SMS provider, per item 6.
      4 e2e tests.
- [x] Email/phone verification — **Complete**: `VerificationService`
      (`src/verification/`) is the first real implementation of the
      `User.emailVerifiedAt`/`phoneVerifiedAt` schema placeholder that's
      existed since Phase 2. One-time 6-digit code (`crypto.randomInt`),
      hashed, 10-minute expiry, 5-attempt throttle after which the
      challenge is consumed and a fresh one must be requested; a new
      request supersedes any still-open prior one for the same purpose.
      Requesting an SMS code with no phone on file is rejected. Same
      `FakeDeliveryAdapter` as password reset — real delivery is
      item 6. `POST/GET /auth/verification/request|confirm`. 4 e2e tests.
- [x] Session listing/revocation — **Complete**: extends the existing
      `RefreshToken` table (no new session-tracking model needed — it
      already captured `userAgent`/`ipAddress`/`familyId` at issuance).
      New `TokenService.listActiveSessions`/`revokeSessionById` +
      `SessionsController`: `GET /auth/sessions`,
      `POST /auth/sessions/:id/revoke` (IDOR-safe — 404s, not another
      user's session, scoped by `userId`), `POST
      /auth/sessions/revoke-all`. 4 e2e tests (list shows multiple
      logins, revoking one doesn't affect others, cross-user revoke
      attempt 404s, revoke-all ends every session).
- [x] MFA (TOTP) — **Complete**: hand-rolled, dependency-free RFC 4226/
      6238 implementation (`src/mfa/totp.util.ts`, verified against the
      official RFC 6238 SHA-1 test vector) — avoids adding `otplib`/
      `speakeasy` for a well-defined, compact algorithm (CLAUDE.md "avoid
      unnecessary dependencies"). Secrets encrypted at rest (AES-256-GCM,
      `MFA_ENCRYPTION_KEY`, required+validated at boot like
      `JWT_ACCESS_SECRET`). Enrollment enforces nothing until confirmed
      with a real code (`MfaService.confirmEnrollment`) — resuming an
      unconfirmed enrollment returns the same secret rather than
      invalidating a QR code already scanned, so incomplete enrollment
      can never lock anyone out. 8 single-use recovery codes issued on
      confirmation (hashed, shown exactly once). `AuthService.login`
      pauses for a short-lived (5m) JWT "MFA challenge" token instead of
      issuing real tokens once an account has confirmed MFA — completed
      via `POST /auth/mfa/verify` (TOTP or recovery code) — wired into
      both the regular `/auth/login` flow and `/admin/session/login`
      (its own `/admin/session/mfa/verify` sets cookies instead of
      returning tokens). Disabling MFA requires a fresh valid TOTP code,
      not just a valid access token. `MfaController`:
      `GET/POST /auth/mfa/status|enroll|confirm|disable`. Broke a
      genuine `AuthModule` ↔ `MfaModule` circular dependency with
      `forwardRef` (same documented pattern already used for
      `AuthModule`↔`UsersModule`); extracted `AdminAuditService` into its
      own dependency-free `AuditModule` so both `AdminAuthModule` and
      `MfaModule` could use it without creating a *second* cycle. 6 TOTP
      unit tests + 7 MFA e2e tests (unconfirmed-enrollment-enforces-
      nothing, status, login challenge + TOTP completion, invalid code
      rejected, recovery code single-use, disable requires a fresh code,
      resuming enrollment returns the same secret). Full suite re-run
      clean after the circular-dependency fix (126 unit + e2e).

### Eligibility & Responsible Gaming
- [x] Centralized real-money eligibility policy service — **Complete**:
      `EligibilityService` (`src/eligibility/`) is now the *only* place
      real-money eligibility is checked — the two call sites that used
      to inline this in `MatchStakesService` (`validateStakeRequest`,
      `confirmStake`) now both delegate to it. Two **independent** flags
      must both be true before any real-money action proceeds —
      `REAL_MONEY_GAMING_ENABLED` (existing, Phase 5) and the new
      `ELIGIBILITY_POLICY_CONFIGURED` — so flipping either alone can
      never silently enable live play with no actual legal policy
      configured behind it (see ADR-021). The existing
      `AUTH_MIN_AGE_YEARS=16` account-creation gate is explicitly
      documented as not a real-money eligibility determination;
      `REAL_MONEY_MINIMUM_AGE` (default 18, a conservative placeholder
      the owner must confirm against real legal advice, not a value
      this codebase invented as authoritative) is the real-money-
      specific check. 7 unit tests (both flags independently gate,
      age gate, self-exclusion/cooling-off block, deposit-limit
      enforcement, withdrawals never blocked).
- [x] Responsible-gaming limits/self-exclusion — **Complete**:
      `ResponsibleGamingService` — self-exclusion, cooling-off, deposit/
      stake/loss limits. Every change is a new row, never a destructive
      edit of a prior one (full history always reconstructable).
      Self-exclusion has **no lift method anywhere in this codebase** —
      not in the service, not on any admin controller — absent a
      defined, legally-authorized compliance-officer role/process, the
      only safe default is that nothing can silently (or even
      deliberately, via an ordinary admin action) turn it back off; see
      ADR-021. Self-exclusion/cooling-off block deposits and real-money
      stakes but **never** withdrawals. Amount limits
      (`deposit-limit`/`stake-limit`) are enforced as a per-action
      ceiling, not a rolling-period sum — documented as a deliberate
      simplification, not a claim of complete spend tracking.
      `loss-limit` is recorded/visible but not yet enforced at
      settlement (documented honestly in the endpoint's own summary,
      not silently claimed as enforced). Self-service endpoints:
      `GET /auth/responsible-gaming/status`,
      `POST .../self-exclude|cooling-off|deposit-limit|stake-limit|loss-limit`.
      7 e2e tests (self-exclusion idempotency, status, blocks deposit,
      does NOT block withdrawal, blocks a real-money staked challenge,
      deposit-limit enforcement, cooling-off blocks deposits).

### Notifications
- [x] Financial notification outbox + FakeDeliveryAdapter — **Complete**:
      `NotificationOutboxService.enqueue(tx, ...)` is always called with
      the *same* transaction as the accompanying ledger write
      (`DepositsService.completeFromProviderEvent`,
      `WithdrawalsService.completeFromProviderEvent`/
      `failFromProviderEvent`) — never emitted before that transaction
      commits (ADR-019). `NotificationDispatcherService` is a plain
      `setInterval` sweep (same no-new-dependency pattern as
      `MatchTimeoutService`) that delivers `PENDING` rows via the shared
      `DeliveryPort`/`FakeDeliveryAdapter`, with a 5-attempt cap;
      delivery failure never rolls back or retries the financial
      operation that produced the row. Also wired:
      `WITHDRAWAL_SUBMITTED` (on moving to `PROCESSING`),
      `DEPOSIT_FAILED`, `SELF_EXCLUSION_ACTIVATED`. 1 e2e test proving
      the full path end-to-end: webhook → ledger write + outbox row in
      one transaction → dispatcher sweep → delivered via the fake
      adapter, with the outbox row's `status` observed `PENDING` then
      `SENT`.

### Mobile / Admin UX
- [x] Admin financial-ops/security UX extensions — **Complete** (see
      "Account Security" above for the cookie/CSRF migration;
      independently re-verified build/lint/test).
- [x] Mobile wallet/security UX extensions — **Complete**. Covers all 7
      scope items: deposit USSD "Payment Code" instructions (with
      polling for the webhook-driven status change, an explicit
      "PlayLe does not complete this for you" framing, and an `EXPIRED`
      badge), withdrawal `PROCESSING` state distinguished from
      `PENDING_REVIEW`/`APPROVED`, TOTP MFA (QR enrollment via
      `qr_flutter` — the one new, justified dependency — confirmation,
      8 recovery codes shown once, disablement, and the login-time
      challenge screen wired through the router's redirect logic),
      password reset (request → confirm → forced re-login, generic
      message displayed verbatim), email/phone verification (dialog
      from the account screen's verification status rows), session
      management (list/revoke/revoke-all), and responsible gaming
      (type-to-confirm `"EXCLUDE ME"` self-exclusion dialog with an
      explicit "cannot be undone, not even by support" warning and a
      "withdrawals are NOT blocked" clarification; cooling-off presets
      + custom duration; deposit/stake/loss limit forms). Built by a
      background agent that hit the account's session rate limit
      partway through (external throttle, not a bug) after substantial
      progress; the remainder (verification, `flutter analyze`/
      `flutter test`/`dart format`, four real bugs, and the Android
      debug build) was completed directly. Bugs found and fixed:
      `main.dart`'s realtime-connect switch didn't handle the new
      `AuthMfaChallenge` state (non-exhaustive-switch analyzer error);
      `account_screen.dart` overflowed vertically once 4 new nav buttons
      were added to a non-scrollable `Column` with a `Spacer` (now
      `SingleChildScrollView`); the test double
      `FakeWalletRepository.createDeposit` unconditionally discarded a
      test-configured `lastDeposit` (so a pre-set `EXPIRED` status or
      `paymentInstructions` never reached the screen under test — the
      `EXPIRED`-badge test's `pumpAndSettle` hung forever because the
      screen kept believing the deposit was still `PENDING` and started
      an unstoppable poll timer); `docs/api/README.md` and
      `apps/api/prisma/schema.prisma`'s own doc comment (copied into
      `docs/database/README.md`) said the responsible-gaming amount-limit
      config key was `dailyLimitMinor`/the verification channel was
      `'PHONE'` — both wrong against the actual code (`limitMinor`,
      `'SMS'`) and now corrected at the source. `flutter analyze`: 0
      issues. `flutter test`: 98/98 passing. `dart format`: clean.
      `flutter build apk --debug`: see Verification below.

### Verification
- [x] Backend unit + e2e tests (real Postgres) — **Complete**, passing
      locally. Redis-dependent matchmaking/realtime e2e tests fail
      locally (no Redis installed in this sandbox — pre-existing,
      documented limitation) and are expected to pass in CI's real
      Redis service container.
- [x] Mobile `flutter analyze`/`flutter test`/`dart format` — **Complete**,
      all clean (98/98 tests).
- [x] Mobile Android debug build — **Complete**: `flutter build apk --debug`
      succeeded (`build/app/outputs/flutter-apk/app-debug.apk`).
- [x] CI green — **Complete**. Verified via the real GitHub Actions API
      (not a local-pass assumption): the first push (`c65b618`) failed
      two jobs (backend typecheck — two stale test files; admin format
      check — two unformatted files from the delegated migration), both
      fixed and re-pushed (`41e9ce5`), which then surfaced a real bug —
      `CsrfGuard` throwing on every WebSocket message (see "CI findings"
      below) — fixed and re-pushed (`b416e46`). That run
      (https://github.com/Ahmed004-art/playLe/actions/runs/38269829729)
      is `completed`/`success` across all three jobs (Backend, Mobile,
      Admin).
- [x] Documentation — **Complete**: CLAUDE.md, README.md, SECURITY.md,
      docs/database/README.md, docs/api/README.md,
      docs/architecture/OVERVIEW.md, docs/architecture/PROJECT_STRUCTURE.md,
      three new ADRs (019/020/021), MONIME_SETUP.md — all independently
      reviewed against the actual code/schema/endpoints, not merely
      accepted as reported.

### Security review pass
- Audited every new endpoint for brute-force protection, IDOR, secret/PII
  logging. Found and fixed one real gap: `POST /auth/mfa/confirm` and
  `POST /auth/mfa/disable` both check a guessable 6-digit TOTP code but
  had no throttle — a caller already holding a valid access token could
  have brute-forced either with no rate limit. Both now carry the same
  `auth` throttle profile as login/password-reset/verification. No
  secret/PII values found logged anywhere in the new modules (checked
  every `logger.*` call in `mfa/`, `password-reset/`, `verification/`,
  `admin-auth/`, `notification-outbox/`, `eligibility/`, plus the
  payment-provider/withdrawal/deposit logging already in place).
- Webhook replay: unchanged from Phase 3 — `ProviderEvent`'s
  `@@unique([provider, providerEventId])` constraint is the dedup
  mechanism, exercised by a dedicated e2e test (`payments-phase6.e2e-spec.ts`,
  "a duplicate payout webhook delivery is ignored").
- IDOR: every new resource (sessions, deposits/withdrawals, provider-ops
  admin views) follows the existing scoped-404 pattern.
- Admin privilege misuse: no new unrestricted "declare success"/"edit
  balance"/"lift restriction" endpoint exists anywhere in Phase 6 —
  every admin action added this phase (anomaly resolution, payment/
  provider visibility, responsible-gaming history) is either read-only
  or requires a mandatory audited reason through the existing ledger/
  withdrawal paths.

### CI findings (found via a real GitHub Actions run, not locally)
- **Real regression, found and fixed**: `CsrfGuard` is registered
  globally (`APP_GUARD`), so it also ran for every WebSocket message
  handler in `RealtimeGateway` (`match:join`, `presence:heartbeat`),
  not just HTTP `/admin/*` routes. It unconditionally called
  `context.switchToHttp().getRequest()` and read `request.path` —
  outside a real HTTP context this throws, so the guard rejected every
  WS message before the handler ever ran, and the client never
  received `match:joined`/`match:error`/`match:state`. This surfaced in
  CI (not locally, where the same local sandbox already lacks Redis and
  masked it behind an apparently-identical "Redis not reachable"-shaped
  timeout) as `realtime.e2e-spec.ts` timing out waiting for
  `match:joined`/`match:error` against a real Redis service container —
  initially misdiagnosed as a recurrence of the historical "Redis
  cold-start race" category (see `git log` around
  `e611a17`/`548d007e`) before `context.getType() !== 'http'` tracing
  revealed the actual cause. Fixed with a one-line guard:
  `CsrfGuard.canActivate` now returns `true` immediately for any
  non-HTTP execution context. Reverified: all 6 `realtime.e2e-spec.ts`
  tests now pass locally with **no Redis running at all** (proving the
  fix, not Redis availability, was the actual variable), and the full
  local e2e suite went from 143/157 passing to 147/157 (the only
  remaining local failure is `matchmaking.e2e-spec.ts`'s own explicit
  "Redis is not reachable" guard — expected in this sandbox, not a bug).
- Two stale test files failed `tsc -p tsconfig.json --noEmit` (the
  backend's dedicated typecheck step, which checks `test/**` too,
  unlike the build/vitest paths already verified locally):
  `auth.service.spec.ts` accessed `.accessToken` on the new
  `LoginResult` union without narrowing past the `mfaRequired` branch,
  and `manual.provider.spec.ts` was missing the new required
  `providerIdempotencyKey` field. Both fixed.
- Two admin files from the delegated frontend-migration work
  (`api-client.ts`, a `page.test.tsx`) weren't Prettier-formatted;
  `format:check` (a dedicated CI step, separate from lint) caught it.
  Fixed with `prettier --write`.

This file is updated as each item lands; see the final Phase 6 report for
the authoritative end-state.
