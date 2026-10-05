# ADR-011: Authentication, Session, and Identity Architecture

## Status
Accepted — Phase 2

## Context
Phase 2 establishes PlayLe's identity layer: accounts, login, sessions, and
the authorization primitives every later phase (wallet, games, social,
admin) will build on. This needed a password strategy, a session/token
strategy, a role model, and an age-gate design, none of which existed
before this phase.

## Decisions

### Password hashing — Argon2id
Passwords are hashed with `argon2` (argon2id variant), never bcrypt/scrypt
or anything weaker, and never stored or logged in plaintext. `argon2id` is
the OWASP-recommended default for new systems — resistant to both GPU
cracking and side-channel attacks, unlike pure argon2i or argon2d.

### Session strategy — short-lived JWT access token + opaque, rotating refresh token
- **Access tokens** are JWTs signed with `JWT_ACCESS_SECRET`, 15 minutes
  by default. The payload is minimal: `{ sub: userId, role }` — never a
  password, email, or anything that goes stale badly mid-lifetime.
- **Refresh tokens** are *not* JWTs. They're cryptographically random
  opaque strings (`crypto.randomBytes(48)`); only a SHA-256 hash is ever
  persisted (`RefreshToken.tokenHash`), so a database read alone can never
  produce a usable token.
- **Rotation + reuse detection**: every refresh issues a new token in the
  same `familyId` and revokes the one just used. Presenting an
  already-revoked token — reuse of a stale token, e.g. a stolen one — is
  treated as a compromise signal and revokes the *entire* family,
  signing out every session descended from that original login. This is
  the standard mitigation for stolen refresh tokens.
- **`JwtAuthGuard` re-reads the user from the database on every request**
  rather than trusting the JWT payload's role/status. This means a
  SUSPENDED/DISABLED status change takes effect on the very next request,
  not only after the (short) access token naturally expires — confirmed
  live: a still-unexpired access token for a user who becomes DISABLED
  mid-session is rejected immediately.
- Password change revokes every refresh token for that user — all
  sessions, everywhere, must re-authenticate.

### Why not a single long-lived JWT, and why not server-side sessions?
- A single long-lived JWT can't be revoked without a blacklist (which is
  just a worse version of what the refresh-token table already is).
- Pure server-side sessions (one opaque cookie, full session state server
  side) would work too, but the access/refresh split lets the common case
  (an authenticated request) skip a database round-trip for token
  *validity* (though this implementation still does one lookup for
  current user status — a deliberate tradeoff documented above, not an
  oversight) while keeping refresh (the less frequent case) fully
  revocable and rotation-checked.

### Role model
`UserRole` is a Postgres enum: `USER`, `ADMIN`. Enforced via two
composable, reusable primitives: `JwtAuthGuard` (authentication — is there
a valid session) and `RolesGuard` + `@Roles(...)` (authorization — does
this session's role satisfy the route's requirement). Adding a role later
means adding an enum value and using `@Roles()` — no guard logic changes.
Authorization is enforced **only** server-side; the admin app's client-side
checks are UX convenience, not the security boundary (verified live: a
valid USER token against an ADMIN-only route gets a real 403 from the
API, not just a hidden button in the UI).

### Identity: email and/or phone, one account
A user has an email (always) and an optional phone number; either can be
used to log in (`identifier` field — the service tries it as an email,
falling back to phone normalization). Email is lowercased/trimmed; phone
numbers are normalized to E.164 via `libphonenumber-js`, defaulting to
Sierra Leone (`SL`) when no country code is given, but accepting any
valid number — so the system isn't hard-coded to never support other
countries later (see ADR-010). Both are enforced unique at the database
level, not just application level, closing the race-condition window a
check-then-insert pattern alone would leave open.

### Age gate — product rule, not KYC
Minimum age is `AUTH_MIN_AGE_YEARS` (default 16), computed server-side
from `dateOfBirth` at registration — the client's own idea of the user's
age is never trusted. This is explicitly a *product* restriction, not
legal/KYC age verification (see Phase 2 spec, Section 7); no identity
document or third-party check is involved.

### Email/phone verification — abstraction only, not implemented
`emailVerifiedAt`/`phoneVerifiedAt` exist on `User` (both start `null`)
so the schema doesn't need to change when verification ships. No OTP
generation, token storage, or email/SMS sending is implemented this phase
— connecting a real provider (and the provider-abstraction interface
itself) is deliberately deferred to its own phase rather than built
speculatively now (see Phase 2 spec, Section 17 and Section 31 of the
Phase 1 spec, "avoid unnecessary dependencies").

### Rate limiting — separately configurable throttle for auth routes
`register`/`login` use a second, stricter named throttler profile
(`AUTH_THROTTLE_LIMIT`/`AUTH_THROTTLE_TTL_MS`, default 5 requests/60s)
registered alongside the existing global default — not a hardcoded value
in the controller, so it can be tuned per environment (production stays
strict; CI/local test runs raise it so an e2e suite's many rapid
register/login calls don't trip it). Verified live: the 6th login attempt
within the window gets a real `429`.

### Redis — not used for authentication in Phase 2
Every piece of Phase 2 session state (refresh tokens, their rotation and
revocation) lives in PostgreSQL, inside the same transactional database as
the account it belongs to. Redis is **not** used for auth in this phase —
there's no session cache, no token blacklist, no distributed rate-limit
store. This keeps the auth system's correctness independent of Redis
being up (confirmed: the full auth flow — register, login, refresh,
logout — works identically whether Redis is reachable or not; only the
`/health` endpoint's `redis` field reflects Redis's own status). Future
phases may use Redis for matchmaking presence or a distributed
rate-limiter across multiple API instances, per ADR-005 — not revisited
here.

## Alternatives Considered
- **bcrypt instead of argon2id** — still acceptable, but argon2id is the
  more modern OWASP-recommended default with no real downside available
  in this stack; chosen instead of bcrypt from the start rather than
  migrating later.
- **`@nestjs/passport` + `passport-jwt`** — the conventional NestJS
  pattern, but adds a dependency and an abstraction layer (strategies)
  for behavior a ~40-line custom `CanActivate` guard implements directly
  with full control and fewer moving parts, given Phase 2's actual needs
  (see Section 31, avoid unnecessary dependencies).
- **Storing refresh tokens as JWTs too** — rejected: a JWT refresh token
  can't be individually revoked without an additional blacklist, which
  is strictly more complexity than the hashed-opaque-token table already
  implemented.

## Consequences
- Every future authenticated endpoint uses `@UseGuards(JwtAuthGuard)` (and
  `RolesGuard` + `@Roles(...)` where role-gated); no new auth primitive
  should be invented ad hoc.
- `User` and `RefreshToken` are the first real Prisma models — the
  `_prisma_migrations` history now matters; see docs/database/README.md.
- The mobile and admin apps both depend on the exact response shapes
  documented in docs/api/README.md; changing them is a breaking API
  change, not a free refactor.
- Known limitation: the admin app persists tokens in `localStorage`
  (XSS-readable), acceptable only because Phase 2 has no real admin
  operations to protect yet — see docs/architecture/SECURITY.md.
