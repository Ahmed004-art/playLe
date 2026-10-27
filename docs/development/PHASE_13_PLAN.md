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

### Not changed / open
- Webhook, admin finance and other previously accidentally-throttled routes are
  now governed by the default limit only.
- Random matchmaking still ignores blocks (documented Phase 12 scope).
- Database-backed e2e suites run only in CI; nothing is device-verified.
