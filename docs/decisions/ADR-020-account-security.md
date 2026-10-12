# ADR-020: Admin Session Cookies, CSRF, Password Reset, Verification & MFA

## Status
Accepted — Phase 6

## Context
The admin dashboard (Phase 2) stored its access/refresh tokens in
`localStorage` — readable by any script on the page, a known XSS risk
flagged in `token-storage.ts`'s own doc comment since it was written.
Phase 6's spec required moving off it without building a second
authentication system, plus adding password reset, email/phone
verification (a schema placeholder since Phase 2), session management,
and MFA.

## Decision

### Admin sessions: a transport change, not a new auth system
`AdminSessionController` (`POST /admin/session/login|refresh|logout`,
`GET /admin/session/me`) wraps the *same* `AuthService`/`TokenService`
rotating-refresh-token machinery every other client already uses. The
only difference is delivery: `admin_access_token`/`admin_refresh_token`
(httpOnly, `SameSite=Lax`, `Secure` when deployed over HTTPS) instead of
a JSON response body. `JwtAuthGuard` was extended with a cookie fallback
— it only reads the cookie when no `Authorization` header is present —
so every existing Bearer-token client and test is unaffected (reverified
across the full suite after the change). A login with valid credentials
but a non-admin role revokes the session it just issued and returns the
identical generic "Invalid credentials" a wrong password would, so this
endpoint never discloses whether a valid non-admin account exists.

### CSRF: double-submit, scoped to cookie-authenticated requests only
Browsers attach cookies automatically to cross-site requests, which is
what makes cookie-based auth CSRF-exploitable — a `Authorization`
header, by contrast, is never attached automatically, so a Bearer-token
request is not exploitable this way and needs no CSRF check.
`CsrfGuard`, registered globally (`APP_GUARD`), is a no-op for any
request carrying an `Authorization` header, for any non-mutating
method, and for `POST /admin/session/login` itself (no CSRF cookie
exists before login). For everything else under `/admin/*`, the
non-httpOnly `admin_csrf_token` cookie's value must be echoed back in an
`X-CSRF-Token` header. Scoping it this way means it required **zero**
changes to any existing admin controller or its tests.

### Password reset: single-use, hashed, anti-enumeration
`PasswordResetToken` mirrors `RefreshToken`'s own pattern: the raw token
is never persisted, only its SHA-256 hash. `POST
/auth/password-reset/request` returns the identical generic message
whether or not the identifier matches an account (verified by an e2e
test asserting byte-identical response bodies). Confirming a reset
revokes every existing session for the account — the same policy
`AuthService.changePassword` already established.

### Email/phone verification: the first real implementation of an old placeholder
`User.emailVerifiedAt`/`phoneVerifiedAt` existed since Phase 2 as schema
placeholders with no OTP flow. `VerificationService` is that flow: a
6-digit code (`crypto.randomInt`), hashed, 10-minute expiry, a 5-attempt
throttle after which the challenge is consumed and a fresh one must be
requested, and a newer request supersedes (never stacks alongside) an
older unconsumed one for the same purpose.

### Delivery: one shared `DeliveryPort`, one `FakeDeliveryAdapter`
Password reset and verification both deliver through
`src/notifications/`'s `DeliveryPort` abstraction. No real email/SMS
provider is integrated this phase (no credentials exist) —
`FakeDeliveryAdapter` logs and retains a bounded in-memory record purely
for tests/local inspection, and is explicitly documented as never a
production delivery mechanism. This same port is reused by the Phase 6
notification outbox (see below) for financial/security notifications.

### Session management: extending `RefreshToken`, not a new model
`RefreshToken` already captured `familyId`/`userAgent`/`ipAddress` at
issuance (Phase 2). No new session-tracking table was needed — only new
`TokenService` methods (`listActiveSessions`, `revokeSessionById`) and a
`SessionsController` (`GET /auth/sessions`,
`POST /auth/sessions/:id/revoke`, `POST /auth/sessions/revoke-all`).
Revoking one session is scoped by `userId` and 404s (not 403) for
another user's session — the same IDOR-safe precedent used throughout
this codebase since Phase 3.

### MFA: hand-rolled TOTP, no new dependency
RFC 4226 (HOTP)/RFC 6238 (TOTP) are compact, well-defined algorithms —
`src/mfa/totp.util.ts` implements both from scratch using only
`node:crypto`, verified against the official RFC 6238 SHA-1 test vector,
rather than adding `otplib`/`speakeasy` (CLAUDE.md "avoid unnecessary
dependencies"). Secrets are encrypted at rest (AES-256-GCM,
`MFA_ENCRYPTION_KEY` — required and validated at boot, the same pattern
as `JWT_ACCESS_SECRET`). An enrollment enforces nothing until confirmed
with one real code (`MfaService.confirmEnrollment`); resuming an
unconfirmed enrollment returns the *same* secret rather than invalidating
a QR code the user already scanned, so an incomplete enrollment can
never lock anyone out. Eight single-use recovery codes are issued at
confirmation, hashed, shown exactly once.

`AuthService.login` pauses for a short-lived (5-minute) single-purpose
JWT "MFA challenge" token instead of issuing real tokens once an account
has confirmed MFA — no new persisted state, the token itself carries the
pending-login identity and is accepted only by
`MfaService.verifyChallenge`, never by `JwtAuthGuard`. This is wired into
both `/auth/login` (→ `/auth/mfa/verify`, JSON tokens) and
`/admin/session/login` (→ `/admin/session/mfa/verify`, cookies).
Disabling MFA requires a fresh valid TOTP code — a stolen access token
alone cannot turn it off.

### Breaking a genuine circular dependency
`AuthService.login` needs `MfaService.isEnrolled`; `MfaService` needs
`TokenService`, which lives inside `AuthModule` — a real mutual module
dependency. Resolved with `forwardRef()`, the same documented pattern
already used between `AuthModule` and `UsersModule`. `AdminAuditService`
(the new append-only `AdminAuditLog` writer, used by `CsrfGuard`,
`AdminSessionController`, and `MfaService`) was extracted into its own
dependency-free `AuditModule` specifically so both `AdminAuthModule` and
`MfaModule` could depend on it without creating a *second* cycle.

## Alternatives Considered
- **A bearer-token-only admin API with the frontend "hiding" the token
  in a closure/non-`localStorage` JS variable** — rejected per the
  spec's explicit instruction: this moves the same vulnerability rather
  than fixing it (the token is still extractable by any script running
  in the page).
- **A global CSRF check on every request regardless of auth transport**
  — rejected: it would have broken every existing Bearer-token-based
  admin test/client for no security benefit, since Bearer tokens aren't
  CSRF-exploitable.
- **A third-party TOTP library** — rejected; see "MFA" above.
- **A separate MFA challenge-tracking table** — rejected; a short-lived
  signed JWT carries the same information with no new persisted state
  and the same expiry guarantee a DB row with a TTL check would give.

## Consequences
- The admin dashboard no longer stores a usable credential in
  JS-readable storage (`token-storage.ts` was deleted).
- Every existing Bearer-token-based admin client, test, and the mobile
  app's own `/auth/*` usage are completely unaffected by any change in
  this ADR.
- MFA, once enrolled, applies uniformly to both regular users and
  admins logging in through either endpoint — there is exactly one
  enrollment/verification implementation, not two.
