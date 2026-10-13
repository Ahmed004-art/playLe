# Security Foundation

This document describes the security posture established through Phase 7
and the security work that remains for later phases. **The application is
not production-secure after Phase 7** — in particular, Monime webhook
signature verification still fails closed (see ADR-019), no live Monime
deposit/payout has been exercised outside test credentials, and all
match-stake testing uses test wallets, not real money. This is a
foundation, not a completed security program. See
`docs/development/OUTSTANDING_WORK.md` for the full, durable list of
everything still open across every phase, not just this section's
summary.

**Phase 7 update**: no new security surface was added (Checkers reuses
the existing auth/command/realtime pipeline unchanged). The Phase 7
repository audit did find and fix two pre-existing *correctness* races
in `MatchTimeoutService`/`ChallengesService` (missing status guards on
two sweep updates; an event emitted before its transaction committed) —
neither was an exploitable vulnerability (no unauthorized access, no
double-spend), both were narrow-timing-window state-integrity bugs; see
the Phase 7 report and `OUTSTANDING_WORK.md` item 12 for detail.

## Implemented in Phase 1

- **Input validation**: global `ValidationPipe` (class-validator /
  class-transformer) on the NestJS API rejects malformed/unexpected
  request payloads before they reach handlers; `whitelist` +
  `forbidNonWhitelisted` strip/reject unknown properties.
- **Environment validation**: the API refuses to boot if required
  environment variables are missing or malformed (`src/config`), so a
  misconfigured deployment fails fast and loudly instead of running with
  silently wrong settings (e.g. an unset JWT secret).
- **Secret handling**: no secrets are committed. `.env.example` files
  document required variables with placeholder values only; `.gitignore`
  excludes all `.env*` files except `*.example`. See "Secret Audit" below.
- **CORS**: configured explicitly with an allow-list driven by
  environment configuration rather than a wildcard default.
- **Security headers**: `helmet` is applied to the NestJS API.
- **Request size limits**: default body-parser limits are kept at
  framework defaults and documented; no endpoint accepts unbounded
  payloads.
- **Rate-limiting architecture**: `@nestjs/throttler` is wired as global
  infrastructure with a conservative default limit (100 requests / 60s).
  Verified live against a running instance: the 101st request within the
  window receives `429 Too Many Requests` in the standard error shape. No
  per-route tuning has been done yet since there are no real endpoints to
  tune.
- **Fail-fast dependency health**: the Redis client is configured with
  `enableOfflineQueue: false` so that commands fail immediately when Redis
  is unreachable instead of queuing indefinitely. Without this, a health
  check (or any future Redis-dependent request) would hang forever rather
  than reporting degraded status — discovered and fixed during Phase 1
  verification against a real, intentionally-unreachable Redis.
- **Audit-log architecture (placeholder)**: structured logging
  (`docs/architecture/OVERVIEW.md` logging section) is designed to be
  extended with dedicated audit events for authentication, financial, and
  administrative actions; no audit log storage exists yet (login/logout
  are not yet written to a dedicated audit trail — only to normal
  application logs, with no sensitive data in them — see below).
- **Admin app**: has no real administrative *operations* yet beyond
  logging in as an admin-role account — no financial/user actions exist
  to protect. Route protection and role enforcement are implemented (see
  below) in preparation for when real controls are added.

## Implemented in Phase 2 — Authentication

Full architecture and reasoning: [ADR-011](../decisions/ADR-011-authentication.md).

- **Password hashing**: `argon2id` via the `argon2` package. Verified live:
  the same password hashes differently each time (random salt); a wrong
  password is rejected; a malformed/foreign hash is rejected, not thrown.
- **Passwords are never logged, never returned from any API response, and
  never placed in a JWT payload.** `UsersService.toSafeUser()` strips
  `passwordHash` before any response is built; grepped the codebase for
  any log statement referencing password/secret/token fields — none found.
- **Access tokens**: short-lived JWTs (15 min default), payload limited to
  `{ sub, role }`.
- **Refresh tokens**: opaque random strings, only a SHA-256 hash persisted;
  rotate on every use; reuse of an already-rotated token revokes the
  entire token family (verified live: reusing a rotated-away token not
  only fails but also invalidates the token that replaced it).
- **Per-request status enforcement**: `JwtAuthGuard` re-reads the user
  from the database on every authenticated request, not just at login —
  verified live, a user disabled mid-session is rejected on their very
  next request with their still-unexpired access token.
- **Brute-force protection**: `register`/`login` use a separately
  configurable, stricter throttle (default 5 requests/60s) from the rest
  of the API — verified live, the 6th login attempt in the window gets a
  real `429`.
- **User-enumeration mitigation**: login always performs a password-hash
  comparison, even when the identifier doesn't match any account (against
  a fixed dummy hash), so response timing doesn't distinguish "wrong
  password" from "no such account." Both return the same generic
  `Invalid credentials` message.
- **Authorization**: `RolesGuard` + `@Roles(...)` enforce role-based
  access **server-side only** — verified live, a valid non-admin token
  against an admin-only route gets a real `403`, not merely a hidden UI
  element.
- **Database-level uniqueness**: `email`, `phoneNumber`, and `username`
  are enforced unique by Postgres constraints, not just application-level
  checks (closes the check-then-insert race window) — verified live and
  via e2e tests (duplicate email/username both correctly rejected with
  `409 Conflict`).
- **Age gate**: computed server-side from `dateOfBirth`; the client's own
  claimed age is never trusted or accepted as input.
- **Admin app**: route protection (`AuthGuard`) and a role check during
  login (a successfully-authenticated non-admin account is immediately
  logged back out of the admin app) — defense in depth on top of the
  server-side enforcement above, which remains the real boundary.

## Implemented in Phase 3 — Financial Foundation

Full architecture and reasoning:
[ADR-012](../decisions/ADR-012-financial-architecture.md),
[ADR-013](../decisions/ADR-013-payment-provider-abstraction.md).

- **No bare mutable balance, ever.** Every balance change goes through
  `LedgerService.applyEntry`, the only method permitted to write a
  `Wallet` or `LedgerEntry` row — verified by code review (no other
  `wallet.update`/`ledgerEntry.create` call site exists) and by e2e tests
  asserting every mutation produces a matching ledger row.
- **Concurrency safety**: pessimistic row locking (`SELECT ... FOR UPDATE`
  inside a Prisma transaction) serializes concurrent mutations against
  the same wallet — verified with a real concurrency test (two
  simultaneous withdrawal requests together exceeding the balance;
  exactly one succeeds against the real database, not a mock).
- **Financial invariants enforced twice**: application-level checks in
  `LedgerService` reject any operation that would drive a balance
  negative, *and* database-level `CHECK` constraints on `wallets`/
  `deposits`/`withdrawals` enforce the same thing as defense in depth.
- **Idempotency**: client-request idempotency via
  `@@unique([userId, idempotencyKey])` on `Deposit`/`Withdrawal`
  (verified: a retried create with the same key returns the original
  record, not a duplicate); provider-event idempotency via
  `@@unique([provider, providerEventId])` on `ProviderEvent` (verified: a
  duplicate webhook delivery credits the wallet exactly once).
- **No client-asserted payment success**: a deposit only becomes
  `COMPLETED` via a verified provider event, never from a client call —
  verified live and in e2e tests.
- **IDOR protection**: a user's deposits/withdrawals are scoped to their
  own `userId`; e2e-verified that another authenticated user gets `404`
  (not `403`, which would confirm existence) for someone else's
  withdrawal.
- **Admin financial authorization**: every `/admin/...` financial route
  uses the same `JwtAuthGuard` + `RolesGuard` + `@Roles('ADMIN')` as
  Phase 2 — no second authorization mechanism. Verified: a non-admin
  token gets a real `403` against every admin finance route.
- **Narrow, audited admin adjustment**: the only balance-editing path
  besides deposits/withdrawals requires a reason (≥10 characters), is
  attributed to the acting admin in the ledger row, and still cannot
  drive a balance negative (same invariant check as every other path).
- **Webhook authenticity fails closed**: `MonimeProvider.verifyWebhookSignature`
  always returns `invalid` — Monime's real signature scheme is
  unverified, so nothing is trusted by default (see ADR-013). The
  `PaymentProviderPort.initiateDeposit` real-network-call path is also
  inert for Monime regardless of configured credentials, closing off any
  accidental call to an unverified endpoint.
- **No secrets in webhook/ledger logs**: `ProviderEvent.payload` stores
  the provider's event body, not configured signing secrets; grepped for
  any log statement that could leak `MONIME_API_KEY`/
  `MONIME_WEBHOOK_SECRET` — none found.

## Implemented in Phase 4 — Game Platform, Matchmaking & Real-Time

Full architecture and reasoning:
[ADR-014](../decisions/ADR-014-realtime-command-transport.md),
[ADR-015](../decisions/ADR-015-game-module-architecture.md).

- **Server authority over outcomes, enforced, not just documented.** A
  move is only ever accepted via `POST /matches/:id/commands`, validated
  by the owning `GameModule` against the current server-held state
  inside a row-locked transaction — a client can never assert a move's
  validity, whose turn it is, or a match's result. Verified by e2e tests
  covering out-of-turn moves, moves on an occupied cell, moves after
  completion, and moves by a non-participant — all rejected server-side.
- **No "set winner" admin override of any kind.** `AdminMatchesController`
  is read-only (`GET` only); there is no endpoint, in the API or the
  admin UI, that lets anyone set or change a match's result — verified by
  code review (no mutating route exists) and by an admin-UI test
  asserting no such control is rendered.
- **Concurrency safety**: the same pessimistic row-locking pattern as
  Phase 3's wallet (`SELECT ... FOR UPDATE` inside a Prisma transaction)
  serializes concurrent command submissions against the same match —
  verified with a real concurrent-request e2e test (two simultaneous
  move submissions; exactly one is accepted, the other correctly
  rejected against the now-current state, against the real database).
  Matchmaking's queue-pop is a single atomic Redis Lua script, preventing
  two concurrent `join` calls from forming two matches from the same
  players.
- **Idempotency**: `MatchCommand.id` is client-supplied and is itself the
  dedup key (`@@unique([matchId, id])`); a retried submission returns the
  original result rather than reapplying the move — verified by e2e
  tests submitting the same command twice.
- **IDOR protection**: `GET /matches/:id` returns `404` (not `403`) for a
  match the requesting user isn't a participant in — e2e-verified,
  matching the Phase 3 precedent for withdrawals.
- **WebSocket authentication**: the gateway authenticates every
  connection via the same `TokenService`/`UsersService` status check
  `JwtAuthGuard` uses for REST, and disconnects the socket on failure. A
  `match:join` room-subscription request is re-verified against real
  `MatchPlayer` membership server-side — the gateway never trusts a
  client's claim to be part of a match. A real race between the
  transport-level `connect` event and the server's async authentication
  completing was found during e2e testing (a client could emit
  `match:join` before the server had finished identifying it) and fixed
  with an explicit server-emitted `connected` acknowledgment the client
  waits for — see ADR-014.
- **Presence is best-effort and narrowly exposed**: presence data is
  only ever surfaced for a user's own current match opponent (via the
  match detail response), never as a general lookup-any-user endpoint; a
  Redis outage degrades presence silently rather than blocking any
  match/matchmaking/challenge flow.
- **Rate limiting**: a dedicated `matches` throttler covers matchmaking,
  challenge, and command endpoints, the same `@nestjs/throttler`
  infrastructure as every other named throttler.
- **Suspended/disabled users rejected on every match route** — the same
  per-request `JwtAuthGuard` status re-check as Phase 2/3, verified by
  e2e tests specific to matches/matchmaking/challenges.
- **Financial isolation verified, not just claimed**: no code path in
  `games/`, `matches/`, `matchmaking/`, or `challenges/` calls
  `LedgerService`, touches `Wallet`, or references the `PRIZE`/
  `PLATFORM_FEE` ledger types — verified by code review (grep for any
  cross-import from the financial modules; none found outside the
  pre-existing Phase 3 code).

## Implemented in Phase 5 — Match Stakes, Settlement, Disputes & Reconciliation

Full architecture and reasoning:
[ADR-016](../decisions/ADR-016-match-financial-architecture.md),
[ADR-017](../decisions/ADR-017-deterministic-settlement.md),
[ADR-018](../decisions/ADR-018-financial-state-machines.md).

- **Server-authoritative settlement, enforced, not just documented.**
  `SettlementService.settle` derives the outcome entirely from the
  match's own already-decided `status`/`winnerUserId`/`resultIsDraw` —
  no caller, client or otherwise, can pass in a winner, a payout, or a
  pool. Verified by e2e tests covering win, draw, disconnect-forfeit,
  and stake-commit-timeout cancellation, each asserting the exact
  resulting balances.
- **No client-controlled money movement anywhere in the pipeline.**
  Stake amount is fixed by whoever initiates (matchmaking request or
  challenge) and never re-negotiated; the opponent can only accept or
  not. The actual hold only ever happens via `POST
  /matches/:id/stake/confirm`, which re-validates eligibility
  server-side at confirm time (not just at request time) and performs
  the hold through the existing `LedgerService.lockWallet`/`applyEntry`
  — the exact same primitives Phase 3 wallet operations use, not a new
  money-movement mechanism.
- **Equal-stake enforced by construction.** `MatchStake.stakeAmountMinor`
  is one value shared by every player, not a per-player column — there
  is no code path that could even express unequal stakes. Matchmaking
  additionally only pairs players who requested the identical amount
  (separate Redis queues per stake tier); verified by e2e test that two
  different stake amounts never pair.
- **Exactly-once settlement is a database constraint, not application
  logic.** `@@unique` on `Settlement.matchStakeId`; `settle()` always
  attempts to create that row first and treats a `P2002` conflict as
  "already settled," returning the existing result — verified by
  calling `settle()` twice in an e2e test and asserting no balance
  changes on the retry.
- **Multi-wallet lock ordering**: settlement is the first place in the
  codebase that locks more than one wallet in a single transaction; every
  movement is sorted by `userId` before locking, preventing a
  reverse-order deadlock between two settlements that happen to share a
  player (see `SettlementService`, ADR-017).
- **Real-money eligibility is checked twice, independently of identity
  eligibility.** `stakes.realMoneyGamingEnabled` (default `false`) and a
  separate `stakes.realMoneyMinimumAge` (distinct from the general
  account age gate) are both re-checked at `confirmStake` time, not only
  at the original join/challenge request — verified by e2e test
  (a too-young account is rejected with `403`).
- **The platform account can never be a player or log in.** Implemented
  as a real `User` row (`role: SYSTEM`, `status: DISABLED`) — `DISABLED`
  already fails `JwtAuthGuard`'s login check and `ChallengesService`'s
  `status: 'ACTIVE'` opponent check with zero Phase-5-specific code.
- **IDOR protection**: `GET /matches/:id/financial` and `POST
  /matches/:id/stake/confirm` both 404 (not 403) for a non-participant;
  `POST /matches/:id/dispute` likewise 404s for a non-participant and
  409s a duplicate open dispute from the same user — all e2e-verified.
- **Disputes never move money.** `DisputesService` has no code path
  that calls `LedgerService` or touches a `Wallet` — verified by code
  review and by an e2e test asserting a resolved (even "upheld")
  dispute changes no balance. A real correction, if warranted, is a
  separate, already-audited admin wallet adjustment (Phase 3's existing
  mechanism) — admin safety: no dispute-resolution shortcut can move
  money by itself.
- **Reconciliation is read-only.** `ReconciliationService.runOnce()`
  (admin-only, `GET /admin/reconciliation/run`) only ever reads and
  reports; it has no write path. Verified by e2e test: a normal settled
  match produces zero anomalies.
- **Crash recovery is idempotent by construction.** The periodic sweep's
  `recoverStuckSettlements()` re-calls `settle()` for any terminal match
  whose stake isn't yet `SETTLED`/`REFUNDED` — safe to call arbitrarily
  many times because `settle()` itself is idempotent (see above).
- **Financial invariants enforced twice, again**: `settlement-math.ts`'s
  `isBalanced` check runs both as an exhaustive unit-test suite (pure,
  no I/O) and as a runtime assertion inside `SettlementService` right
  before every commit — an unbalanced computation is refused, never
  written.

## Implemented in Phase 6 — Production Payments, Account Security & Responsible Gaming

Full architecture and reasoning:
[ADR-019](../decisions/ADR-019-production-payments.md),
[ADR-020](../decisions/ADR-020-account-security.md),
[ADR-021](../decisions/ADR-021-eligibility-and-responsible-gaming.md).

- **Admin sessions moved off `localStorage` to httpOnly cookies.** The
  admin app's access/refresh tokens are now delivered as
  `admin_access_token`/`admin_refresh_token` (httpOnly, `SameSite=Lax`,
  `Secure` when `ADMIN_SESSION_SECURE_COOKIES=true`) by
  `AdminSessionController` (`POST /admin/session/login|refresh|logout`,
  `GET /admin/session/me`), rather than a JSON response body the frontend
  put in `localStorage`. This reuses the *same* `AuthService`/
  `TokenService` rotating-refresh-token machinery every other client
  already uses — a transport change, not a second auth system.
  `JwtAuthGuard` only reads the cookie when no `Authorization` header is
  present, so every existing Bearer-token client/test is unaffected. A
  login with valid credentials but a non-admin role revokes the session
  it just issued and returns the identical generic "Invalid credentials"
  a wrong password would — no privilege-leak. The admin frontend itself
  (`api-client.ts`, `auth-context.tsx`) was migrated to this contract and
  `token-storage.ts` was deleted; see "Known Limitations" below — the
  localStorage note there is now historical, not current.
- **CSRF: double-submit, scoped to cookie-authenticated requests only.**
  `CsrfGuard` (global `APP_GUARD`) is a no-op for any request carrying an
  `Authorization` header (not cookie/CSRF-exploitable), for any
  non-mutating method, and for `POST /admin/session/login` itself (no
  CSRF cookie exists before login). Every other mutating `/admin/*`
  request must echo the non-httpOnly `admin_csrf_token` cookie's value
  back in an `X-CSRF-Token` header, or it is rejected and recorded as
  `CSRF_REJECTED` in the new append-only `AdminAuditLog`.
- **Password reset: single-use, hashed, anti-enumeration.**
  `PasswordResetToken` mirrors `RefreshToken`'s pattern — only a SHA-256
  hash of the token is ever persisted, never the raw value. `POST
  /auth/password-reset/request` returns the identical generic message
  regardless of whether the identifier matches an account (verified by
  an e2e test asserting byte-identical response bodies). Confirming a
  reset revokes every existing session for the account, same policy as
  `AuthService.changePassword`.
- **Email/phone verification codes.** `VerificationChallenge` stores only
  a hash of a 6-digit code (`crypto.randomInt`), 10-minute expiry, a
  5-attempt throttle after which the challenge is consumed and a fresh
  one must be requested, and a newer request supersedes (never stacks
  alongside) an older unconsumed one for the same purpose. Delivery
  (password reset and verification both) goes only through
  `FakeDeliveryAdapter` (`src/notifications/`) — it logs and retains a
  bounded in-memory record for tests/local inspection and is explicitly
  documented as never a production delivery mechanism; no real email/SMS
  provider is integrated this phase.
- **MFA (TOTP), hand-rolled, no new dependency.** `src/mfa/totp.util.ts`
  implements RFC 4226 (HOTP)/RFC 6238 (TOTP) from scratch with
  `node:crypto` only, verified against the official RFC 6238 SHA-1 test
  vector — not `otplib`/`speakeasy` (CLAUDE.md "avoid unnecessary
  dependencies"). Secrets are encrypted at rest (AES-256-GCM,
  `MFA_ENCRYPTION_KEY`, required and validated at boot like
  `JWT_ACCESS_SECRET`). An enrollment enforces nothing until confirmed
  with one real code; resuming an unconfirmed enrollment returns the
  same secret rather than invalidating an already-scanned QR code, so an
  incomplete enrollment can never lock anyone out. Eight single-use
  recovery codes are hashed and shown exactly once at confirmation.
  `AuthService.login` pauses for a short-lived (5-minute) single-purpose
  JWT "MFA challenge" token once an account has confirmed MFA — it
  carries the pending-login identity, is accepted only by
  `MfaService.verifyChallenge`, and is never accepted by `JwtAuthGuard`.
  Disabling MFA requires a fresh valid TOTP code — a stolen access token
  alone cannot turn it off.
- **Session management**: extends the existing `RefreshToken` table
  (already captured `familyId`/`userAgent`/`ipAddress` at issuance) with
  `GET /auth/sessions`, `POST /auth/sessions/:id/revoke` (IDOR-safe —
  404s, not another user's session, scoped by `userId`), `POST
  /auth/sessions/revoke-all` — the same IDOR-safe precedent used
  throughout this codebase since Phase 3.
- **Payment-provider idempotency / exactly-once payouts.** Every outbound
  Monime call carries a `providerIdempotencyKey`, minted once and
  persisted on a `ProviderOperation` row; a retry of the *same*
  PlayLe-side attempt reuses that key rather than minting a fresh one. A
  network error during payout submission is recorded as an `UNKNOWN`
  `ProviderOperation` and the withdrawal moves to `PROCESSING` —
  **never** retried with a new idempotency key, since the real-world
  outcome of the original request is genuinely unknown. Resolution is
  only ever a later webhook, an explicit `checkPayoutStatus` query
  against that exact operation, or an admin resolving it by hand after
  out-of-band reconciliation (still mandatory-reason, still audited,
  never a "just mark it paid" shortcut). See ADR-019.
- **Production activation requires two independent deliberate choices.**
  A `mon_test_...` token always runs; a live `mon_...` token additionally
  requires `MONIME_LIVE_PAYMENTS_ENABLED=true` — flipping
  `PAYMENTS_PROVIDER=monime` alone can never silently start making real
  payment-provider calls. Separately, `REAL_MONEY_GAMING_ENABLED` and the
  new `ELIGIBILITY_POLICY_CONFIGURED` must **both** be true before any
  real-money action proceeds, so flipping either alone can never
  silently enable real-money play with no configured legal policy behind
  it (see ADR-021).
- **Webhook signature verification remains fail-closed — not resolved.**
  The exact byte string Monime's `Monime-Signature` header HMAC-SHA256
  covers was not verifiable against any source reachable during this
  implementation. `MonimeProvider.verifyWebhookSignature` therefore
  **always returns invalid**, exactly extending (never weakening) the
  fail-closed stance Phase 3 shipped. This is explicitly not fixed in
  Phase 6 — see ADR-019, "Open/Unverified", and
  `docs/development/MONIME_SETUP.md`.
- **Self-exclusion has no lift path anywhere in this codebase, by
  design.** `ResponsibleGamingRestriction` rows are never destructively
  edited — a change is always a new row, so history is always
  reconstructable. `SELF_EXCLUSION` is the one restriction type with no
  lift method — not in `ResponsibleGamingService`, not on any admin
  controller, not reachable by any role. This is a deliberate decision,
  not an oversight: absent a defined, legally-authorized
  compliance-officer process (which doesn't exist in this codebase and
  can't be invented by an automated implementation), the only safe
  default is that self-exclusion can't be turned back off, silently or
  deliberately, by an ordinary admin action. Self-exclusion/cooling-off
  block deposits and real-money stakes but never withdrawals —
  `EligibilityService.assertCanWithdraw` is an explicit no-op, since
  letting an at-risk user get their own money *out* is the
  responsible-gambling-correct behavior, not a loophole. See ADR-021.
- **Centralized eligibility, one call site.** `EligibilityService`
  (`src/eligibility/`) is now the only place real-money eligibility is
  checked; the two inline checks previously duplicated inside
  `MatchStakesService` were deleted in favor of calling it, and
  `DepositsService.create` now calls it too.

## Implemented in Phase 8 — Server-Enforced Responsible Gaming & Financial Safety

Full architecture: [ADR-023](../decisions/ADR-023-rolling-window-responsible-gaming.md).

- **Rolling-window `STAKE_LIMIT`/`DEPOSIT_LIMIT`/`LOSS_LIMIT` are now
  genuinely enforced**, not just recorded. `STAKE_LIMIT`/`DEPOSIT_LIMIT`
  sum real `LedgerEntry` rows (`STAKE_HOLD`/completed `DEPOSIT`) within a
  fixed rolling window; `LOSS_LIMIT` sums real `SettlementEntry` rows
  with `role: 'LOSER'` only — a win, draw, or refund is excluded by
  construction, not by a separate filter that could drift out of sync
  with settlement.
- **The rolling window length is a fixed platform parameter
  (`RESPONSIBLE_GAMING_WINDOW_HOURS`), never user-configurable.** A
  per-user window would let a user shrink their own window to weaken an
  otherwise-correct limit amount — closed by construction rather than by
  validation.
- **Enforcement reuses the existing wallet row lock, not a new
  mechanism.** `EligibilityService.assertCanStake`'s rolling checks run
  inside `MatchStakesService.confirmStake`'s transaction, immediately
  after `LedgerService.lockWallet` already takes its
  `SELECT ... FOR UPDATE` lock — so two concurrent stake confirmations
  for the same user are serialized before either one's rolling-sum query
  runs, the same guarantee every other financial mutation in this
  codebase already relies on.
- **Exactly-once settlement accounting was verified, not assumed.** A
  dedicated e2e test calls `SettlementService.settle` twice for the same
  match and asserts the loser's `SettlementEntry` count stays at exactly
  1, proving the pre-existing `Settlement.matchStakeId` uniqueness
  constraint also protects the new rolling-loss sum from double-counting
  on retry or crash recovery.
- **A real pre-existing eligibility gap was found and fixed.**
  `ChallengesService.accept()` checked only the challenger's eligibility
  (at creation time); the opponent's eligibility was never checked
  before this phase, meaning a self-excluded or over-limit user could
  accept an incoming staked challenge. Fixed by calling
  `EligibilityService.assertCanStake` for the opponent inside `accept()`.
- **A documented, accepted limitation, not silently claimed as fully
  solved**: `DEPOSIT_LIMIT`'s rolling check cannot hold a lock against a
  future asynchronous provider-webhook completion the way the stake
  check can hold a lock against a concurrent request — see ADR-023
  "Deposit-limit rolling check" and `OUTSTANDING_WORK.md` item 18.

## Implemented in Phase 9 — Match Lifecycle Integrity, Matchmaking Correctness & Game Result Semantics

Full architecture: [ADR-024](../decisions/ADR-024-match-lifecycle-integrity.md).

- **Duplicate-match prevention is now a real, race-closed guarantee, not
  just an advisory check.** `MatchesService.createMatchGuarded` acquires
  sorted Postgres advisory transaction locks
  (`pg_advisory_xact_lock(hashtext(userId))`) for every involved user,
  then re-checks none of them holds a `WAITING`/`READY`/`ACTIVE` match,
  then creates the match — all inside one transaction. Used by both
  `MatchmakingService.join`'s post-pop step and
  `ChallengesService.accept`, so two concurrent match-forming attempts
  sharing a user (matchmaking vs. challenge-accept, or two concurrent
  challenge-accepts) can never both succeed. Verified by a real
  concurrent-request e2e test (two challenges accepted simultaneously by
  the same user — exactly one succeeds, the other's challenge rolls back
  to `PENDING`, not left half-resolved) and, for the matchmaking-specific
  path, a real-Redis e2e test.
- **Redis/Postgres consistency-boundary mismatches are explicitly
  recovered from, not pretended impossible.** If `createMatchGuarded`
  rejects one of the users the Redis Lua script already popped,
  `MatchmakingService.join` re-checks each popped user and safely
  re-queues whoever is genuinely still free, rather than silently
  dropping them from the system. Verified by a dedicated real-Redis e2e
  test that deliberately constructs this exact race.
- **Server-authoritative turn timers, closing a real stalling vector.**
  A connected player who simply never moves can no longer hold an
  `ACTIVE` match (and any held stake) indefinitely — `Match.turnDeadlineAt`
  (a real, recoverable column) is enforced by
  `MatchTimeoutService.processTurnTimeout` under the exact same
  `SELECT ... FOR UPDATE` row lock `MatchesService.submitCommand` already
  takes, so a move racing a timeout sweep can never both win, and the
  mechanism needs no in-memory state to survive an API restart or to be
  safe across multiple API instances.
- **Resign and draw-offer commands reuse the existing server-authoritative
  pipeline, not a new one.** `RESIGN`/`DRAW_OFFER`/`DRAW_ACCEPT`/
  `DRAW_REJECT` are processed inside the exact same row-locked transaction
  a move already uses. A resignation always forfeits the authenticated
  submitter — there is no payload field for "who resigns" — so a losing
  participant resigning on behalf of the opponent is impossible by
  construction. A draw offer is never itself a completed draw; only the
  *other* participant's `DRAW_ACCEPT` completes the match, and accepting
  your own offer is rejected explicitly.
- **No financial code path changed.** Resignation, turn timeout, and an
  agreed draw all settle through the exact same `SettlementService.settle`
  — they only ever set the same `Match.winnerUserId`/`resultIsDraw`
  fields a normal game-rules completion already sets (plus a new
  `terminationReason` value distinguishing *how*), so the settlement
  math, the exactly-once guarantee, and the Phase 8 eligibility checks
  are all exercised completely unchanged.

## Explicitly NOT Implemented Through Phase 9

- Real email/SMS delivery for password reset and verification codes —
  the OTP flows themselves (`VerificationService`, `PasswordResetService`)
  are implemented as of Phase 6, but delivery goes only through
  `FakeDeliveryAdapter` (logs + in-memory record); no real provider
  credentials exist (see ADR-020).
- A dedicated "your active sessions" UI in the admin app — the backend
  (`GET /auth/sessions`, revoke, revoke-all) is implemented as of Phase 6
  (see ADR-020), and the mobile app's `sessions_screen.dart` surfaces it
  (corrected during the Phase 7 audit — this line previously said no
  frontend surfaced it at all, which was already stale); no admin-side
  equivalent exists yet.
- KYC / identity verification of withdrawal destinations (`destinationDetails`
  is stored as unverified metadata — see ADR-012).
- Live real-money deposits or payouts — `MonimeProvider` now makes real
  HTTP calls against Monime's test environment (Phase 6), but a live
  (`mon_...`) token additionally requires `MONIME_LIVE_PAYMENTS_ENABLED=true`,
  and inbound webhook signature verification still always fails closed
  (see "Webhook signature verification remains fail-closed" above and
  ADR-019), so a live deposit/payout cannot yet be automatically
  confirmed. `ManualProvider` remains the default active provider.
- Additional games beyond Tic-Tac-Toe and Checkers (both the
  `GameModule` contract and the financial pipeline are designed to
  support them without changes — Checkers itself, added in Phase 7,
  needed zero changes to either — but no further game is implemented;
  see [ADR-022](../decisions/ADR-022-checkers-game-module.md)).
- A verified legal/compliance real-money eligibility policy — Phase 6
  added a required second flag (`ELIGIBILITY_POLICY_CONFIGURED`) and a
  documented conservative placeholder minimum age
  (`REAL_MONEY_MINIMUM_AGE`), but no actual legal review or KYC has been
  performed; the flag only records that the owner confirms a policy
  exists, never that this codebase determined one is correct (see
  ADR-021).
- Any self-exclusion-lift process — by design, not an oversight; see
  "Self-exclusion has no lift path" above and ADR-021.
- Match-level anti-cheat/anomaly detection (e.g. detecting a player
  deliberately disconnecting to avoid a loss) beyond the disconnect
  grace-period forfeit rule already implemented.
- Fraud detection.
- Secret management via a vault/KMS (local `.env` files only, appropriate
  for local development, not production).
- Dependency vulnerability scanning automation (can be added to CI later,
  e.g. `npm audit` / Dependabot).
- Penetration testing / formal third-party security review.

### Dependency audit conclusion (Phase 1 verification)

`npm audit` reports 8 remaining findings (down from 13 after removing the
unused `@nestjs/mau` devDependency — see below). All 8 are transitive
dev-tooling-only dependencies with no path into the production runtime:

- 3 are inside the `prisma` CLI's own dependency chain
  (`prisma` → `@prisma/config` → `deepmerge-ts`). The CLI is a
  devDependency used only for local/CI schema generation and migrations;
  `@prisma/client` (the package actually imported by the running
  application) has zero dependencies and zero reported vulnerabilities.
- 5 were inside `@nestjs/mau` (Nest's cloud-deploy CLI) → `inquirer` /
  `undici` / `tmp` / `external-editor`. `@nestjs/mau` was never imported
  or invoked anywhere in this codebase (Phase 1 does not deploy via Mau),
  so it was removed entirely as dead weight, which also removed its 5
  vulnerabilities outright — a genuine fix, not a suppression.
- The remaining findings (`eslint-config-next` → `@next/eslint-plugin-next`
  → `fast-glob` → `micromatch`/`braces`) are inside the admin app's lint
  tooling, which only globs this repository's own trusted source files.

`npm audit fix --force`'s suggested fixes for every remaining finding are
major-version **downgrades** (e.g. `eslint-config-next` to a version that
predates Next.js 16 support, `prisma` to an older 6.x patch) that would
either break the build or provide no real benefit, since none of these
packages process untrusted input in Phase 1. None were applied.

**Phase 3 update**: the financial foundation (wallet, ledger, deposits,
withdrawals, payment-provider abstraction) introduced **zero new npm or
Dart dependencies** — it's built entirely on packages already present
from Phase 1/2 (Prisma, NestJS, class-validator) plus Node's built-in
`crypto`/`BigInt`. `npm audit` after Phase 3 reports the same 8 findings,
unchanged.

**Phase 4 update**: the game platform introduced exactly one new
dependency, `socket.io-client` (`apps/api`, **devDependency only**,
matching the server's already-present `socket.io` version), used solely
by `test/realtime.e2e-spec.ts` to drive a real WebSocket client against
the gateway in tests — it is never imported by any runtime (`src/`) code.
No new runtime dependency was added anywhere (API, admin, or mobile);
the generic game-module/matchmaking/challenge/real-time layer is built
entirely on NestJS, Prisma, `ioredis`, and `@nestjs/websockets`/
`socket.io`, all already present since Phase 1.

**Phase 5 update**: the match-financial engine introduced **zero new
npm or Dart dependencies** — built entirely on Prisma, NestJS,
class-validator, and Node's built-in `crypto`/`BigInt`, same as Phase 3.
The platform/system account's seed password hash was generated once,
at migration-authoring time, using the `argon2` package already present
since Phase 2 (via a throwaway one-off script, not a new runtime call
path). `npm audit` after Phase 5 reports the same findings as Phase 4,
unchanged.

**Phase 6 update**: one new backend runtime dependency, `cookie-parser`
(`apps/api`, plus its `@types/cookie-parser` dev typings) — needed to
read the new httpOnly `admin_access_token`/`admin_refresh_token`/
`admin_csrf_token` cookies, since the framework has no built-in cookie
parser. MFA (TOTP/HOTP) was deliberately hand-rolled against
`node:crypto` rather than adding `otplib`/`speakeasy` (see ADR-020). One
new mobile dependency, `qr_flutter` (renders the MFA enrollment QR
code) — corrected during the Phase 7 audit, this paragraph previously
said no other new dependency was added anywhere, which was already
stale. No new admin dependency.

**Phase 7 update**: zero new dependencies anywhere (API, admin, or
mobile) — confirmed via `git diff` on every `package.json`/`pubspec.yaml`.
Checkers' board rendering uses only Flutter's built-in widgets.

**Phase 9 update**: zero new dependencies anywhere (API, admin, or
mobile) — confirmed via `git diff` on every `package.json`/`pubspec.yaml`.
Advisory locks use a plain `$executeRaw` call against the existing
Postgres connection; the turn-timer countdown uses `dart:async`'s
built-in `Timer.periodic`.

## Known Limitations

- The development database and Redis instances run with default/simple
  local credentials suitable only for local development (see
  `infrastructure/docker/docker-compose.yml` and `.env.example`). These
  must never be reused for staging/production.
- No HTTPS/TLS termination is configured locally; this is expected to be
  handled by the deployment platform in a later phase, not by the
  application itself.
- No automated secret-scanning is wired into CI yet; the current
  safeguard is `.gitignore` plus manual review before every commit.
- ~~The admin app stores session tokens in `localStorage`~~ — **closed in
  Phase 6**. The admin app now uses httpOnly, `SameSite=Lax` cookies
  issued by `AdminSessionController`, with CSRF protection via
  `CsrfGuard`; `apps/admin/src/lib/token-storage.ts` was deleted. See
  "Implemented in Phase 6" above and ADR-020.
- No real email/SMS delivery provider exists yet — password-reset and
  verification *codes* are generated, hashed, and consumed correctly as
  of Phase 6 (`POST /auth/password-reset/request|confirm`,
  `POST/GET /auth/verification/request|confirm`), but delivery is a
  tested `FakeDeliveryAdapter` only (see ADR-020) — an account can run
  the self-service recovery flow, but the actual code never reaches a
  real inbox/phone outside of logs/test fixtures.
- `JWT_ACCESS_SECRET` is a single static secret per environment with no
  rotation mechanism.
- The `DEPOSIT_LIMIT` rolling-window check cannot offer the same
  concurrency guarantee as the `STAKE_LIMIT`/`LOSS_LIMIT` checks, since
  deposit completion is driven by an asynchronous provider webhook with
  no request in flight to lock against (Phase 8; see ADR-023 and
  `OUTSTANDING_WORK.md` item 18). It still correctly blocks initiating a
  new deposit once already-completed deposits would exceed the limit.
- `Withdrawal.destinationDetails` (e.g. a mobile-money phone number) is
  stored as-given, with no verification that it belongs to the
  requesting user — KYC/destination-ownership verification is explicitly
  future work (see ADR-012).
- No *live* payment provider is connected — `MonimeProvider` makes real
  calls against Monime's test environment as of Phase 6, but a live
  token requires a separate flag and inbound webhook signature
  verification still always fails closed — see "Explicitly NOT
  Implemented" above and ADR-019.
- The matchmaking concurrency/atomicity guarantee (the Redis Lua
  queue-pop script) is exercised by `test/matchmaking.e2e-spec.ts`, which
  requires a real Redis instance (normally provided by
  `npm run docker:up`, see `docs/development/SETUP.md`). In this
  particular development environment Docker/WSL were unavailable, so
  that suite was verified via a real GitHub Actions CI run (which
  provisions a genuine Redis service container) rather than locally —
  an environment-specific gap, not a gap in the test itself.
- Phase 5's financial-engine migration needed a database role with
  `CREATEDB`/type-ownership to author (see "Migration Discipline" in
  `docs/database/README.md`); the default local `playle` runtime role
  deliberately doesn't have it. In this development environment, that
  was worked around by initializing a second, throwaway local Postgres
  cluster (a plain `initdb`/`pg_ctl` on a different port, owned by the
  session running it) purely to author and verify the migration and run
  the full non-Redis e2e suite against a real database — the committed
  migration files are identical to what any contributor with normal
  Docker access would produce via `npm run docker:up`.

## Future Security Requirements (Later Phases)

- Authorization: role-based access control for player vs. admin vs.
  future staff roles beyond the current USER/ADMIN split.
- A real email/SMS delivery provider for password reset and
  verification codes (the flows themselves, and session/device
  management endpoints, are implemented as of Phase 6 — see above; the
  mobile app's `sessions_screen.dart` surfaces session management, but
  no equivalent exists in the admin app yet).
- Financial security: a real Monime webhook signature implementation
  once the canonical HMAC string is verified (see ADR-019), anomaly
  detection beyond the read-only reconciliation checks already
  implemented (Phases 5/6). Idempotency itself is implemented as of
  Phase 3 (see above). Rolling-window spend/loss-limit enforcement is
  implemented as of Phase 8 (see ADR-023 and "Implemented in Phase 8"
  below).
- KYC integration ahead of/alongside withdrawal automation and
  destination-account verification.
- Payment provider credential handling via a proper secrets manager, not
  `.env` files, once deployed.
- Structured, tamper-evident audit logging beyond the current
  `AdminAuditLog` (Phase 6, admin session/CSRF/MFA/password-reset events
  only) — extending it to every authentication and financial action, not
  just admin-facing ones, remains future work.
- Rate limiting tuned per endpoint, with stricter limits on
  authentication and financial endpoints.
- Automated dependency and secret scanning in CI.
- A formal security review before handling real user funds in production.

## Secret Audit Process

Before every commit:

1. Review `git status` output for unexpected files.
2. Confirm no `.env` (non-`.example`) file is staged.
3. Grep staged diffs for likely secret patterns (API keys, private keys,
   JWT secrets, connection strings with embedded credentials) before
   pushing. Also grep the full `git log -p` history occasionally, not
   just the current diff.
4. Confirm no password, access token, or refresh token value appears in
   any log statement, test fixture committed to the repo, or this
   document itself.

This is a manual process; automating it is listed under Future Security
Requirements above.
