# Security Foundation

This document describes the security posture established through Phase 3
and the security work that remains for later phases. **The application is
not production-secure after Phase 3** — in particular, no real money can
move yet (see ADR-013). This is a foundation, not a completed security
program.

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

## Explicitly NOT Implemented Through Phase 3

- Email/SMS verification delivery (schema fields exist, no provider
  integration or OTP flow — see ADR-011).
- Password reset flow (not required this phase; no reset-token table
  exists).
- Multi-factor authentication.
- Device/session management UI (sessions are revocable at the data layer
  via refresh-token rotation, but there's no "your active sessions" UI).
- KYC / identity verification of withdrawal destinations (`destinationDetails`
  is stored as unverified metadata — see ADR-012).
- Real-money deposits or payouts — `ManualProvider` is active and makes
  no network call; `MonimeProvider` is an inert boundary pending verified
  Monime access (see ADR-013, `docs/development/MONIME_SETUP.md`).
- Betting/prize-pool settlement, platform fees (ledger types reserved,
  not produced yet).
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
- **The admin app stores session tokens in `localStorage`**, which is
  readable by any script on the page (XSS risk). This was accepted in
  Phase 2 because there were no real operations to protect; **that is no
  longer true** — the admin app now approves/rejects withdrawals and
  adjusts wallet balances. This is flagged explicitly as a gap that must
  be closed (move to httpOnly, SameSite cookies set by the API — see
  `apps/admin/src/lib/token-storage.ts` and ADR-011) before any of this
  is used against real money in production.
- No password-reset or email/SMS verification flow exists yet — an
  account with a forgotten password currently has no self-service
  recovery path.
- `JWT_ACCESS_SECRET` is a single static secret per environment with no
  rotation mechanism.
- `Withdrawal.destinationDetails` (e.g. a mobile-money phone number) is
  stored as-given, with no verification that it belongs to the
  requesting user — KYC/destination-ownership verification is explicitly
  future work (see ADR-012).
- No real payment provider is connected — see "Explicitly NOT
  Implemented" above and ADR-013.

## Future Security Requirements (Later Phases)

- Authorization: role-based access control for player vs. admin vs.
  future staff roles beyond the current USER/ADMIN split.
- Email/SMS verification delivery, password reset, multi-factor
  authentication, session/device management UI.
- Financial security: a real Monime (or other provider) webhook
  signature implementation once documentation/credentials are verified,
  reconciliation jobs, anomaly detection (Fraud module). Idempotency
  itself is implemented as of Phase 3 (see above).
- KYC integration ahead of/alongside withdrawal automation and
  destination-account verification.
- Payment provider credential handling via a proper secrets manager, not
  `.env` files, once deployed.
- Structured audit logging for every authentication, financial, and
  administrative action, with tamper-evident storage.
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
