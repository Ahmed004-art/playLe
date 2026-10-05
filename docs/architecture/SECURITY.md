# Security Foundation

This document describes the security posture established through Phase 2
and the security work that remains for later phases. **The application is
not production-secure after Phase 2.** This is a foundation, not a
completed security program.

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

## Explicitly NOT Implemented Through Phase 2

- Email/SMS verification delivery (schema fields exist, no provider
  integration or OTP flow — see ADR-011).
- Password reset flow (not required this phase; no reset-token table
  exists).
- Multi-factor authentication.
- Device/session management UI (sessions are revocable at the data layer
  via refresh-token rotation, but there's no "your active sessions" UI).
- KYC.
- Any financial operation or fraud detection.
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
  readable by any script on the page (XSS risk). Acceptable for now since
  the admin app has no real operations to protect; a hardened build
  should move to httpOnly, SameSite cookies set by the API (see
  `apps/admin/src/lib/token-storage.ts` and ADR-011).
- No password-reset or email/SMS verification flow exists yet — an
  account with a forgotten password currently has no self-service
  recovery path.
- `JWT_ACCESS_SECRET` is a single static secret per environment with no
  rotation mechanism.

## Future Security Requirements (Later Phases)

- Authorization: role-based access control for player vs. admin vs.
  future staff roles beyond the current USER/ADMIN split.
- Email/SMS verification delivery, password reset, multi-factor
  authentication, session/device management UI.
- Financial security: idempotency keys, transaction signing/verification
  where applicable, reconciliation jobs, anomaly detection (Fraud module).
- KYC integration ahead of/alongside withdrawal automation.
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
