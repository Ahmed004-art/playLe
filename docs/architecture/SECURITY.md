# Security Foundation

This document describes the security posture established in Phase 1 and
the security work that remains for later phases. **The application is not
production-secure after Phase 1.** This is a foundation, not a completed
security program.

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
  infrastructure with a conservative default limit. No per-route tuning
  has been done yet since there are no real endpoints to tune.
- **Authentication architecture (placeholder)**: module boundaries and
  request-lifecycle hooks (guards) exist for where authentication will be
  enforced; no real authentication (login, tokens, sessions) is
  implemented in Phase 1.
- **Authorization architecture (placeholder)**: the same applies to
  role/permission checks — the guard/decorator pattern is established,
  not populated with real roles yet.
- **Audit-log architecture (placeholder)**: structured logging
  (`docs/architecture/OVERVIEW.md` logging section) is designed to be
  extended with dedicated audit events for authentication, financial, and
  administrative actions; no audit log storage exists yet.
- **Admin app**: has no real administrative controls yet, so it currently
  carries no elevated-privilege attack surface beyond a normal Next.js
  app. Authentication/authorization placeholders exist for when real
  controls are added.

## Explicitly NOT Implemented in Phase 1

- Real user authentication (no login, no password hashing, no sessions,
  no tokens are issued).
- Real authorization/roles.
- KYC.
- Any financial operation or fraud detection.
- Production-grade rate-limit tuning per endpoint.
- Secret management via a vault/KMS (Phase 1 uses local `.env` files only,
  appropriate for local development, not production).
- Dependency vulnerability scanning automation (can be added to CI later,
  e.g. `npm audit` / Dependabot).
- Penetration testing / formal security review.

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

## Future Security Requirements (Later Phases)

- Authentication: password hashing (e.g. argon2/bcrypt), token issuance
  and rotation, session/device management.
- Authorization: role-based access control for player vs. admin vs.
  future staff roles.
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

## Secret Audit Process (Phase 1)

Before every commit:

1. Review `git status` output for unexpected files.
2. Confirm no `.env` (non-`.example`) file is staged.
3. Grep staged diffs for likely secret patterns (API keys, private keys,
   connection strings with embedded credentials) before pushing.

This is a manual process in Phase 1; automating it is listed under Future
Security Requirements above.
