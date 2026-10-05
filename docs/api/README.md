# API

## How Mobile and Admin Talk to the API

Both `apps/mobile` (Flutter) and `apps/admin` (Next.js) talk to `apps/api`
(NestJS) over:

- **REST over HTTPS** for request/response operations, documented via
  OpenAPI/Swagger (served at `/api/docs` in development — see
  `apps/api/src/main.ts`).
- **WebSockets (Socket.IO)** for real-time match state, per
  [ADR-006](../decisions/ADR-006-realtime.md). Not implemented for actual
  game events in Phase 1 — connection lifecycle only.

Because Flutter/Dart cannot consume the TypeScript `packages/shared`
contracts, the mobile app's request/response models are (in Phase 1 and
near-term) hand-written Dart classes kept in sync with the OpenAPI spec by
convention. The admin app, being TypeScript, can import shared types
directly from `@playle/shared`. Automatic Dart client generation from the
OpenAPI spec may be introduced later if/when the API surface is large
enough to justify the tooling (see `CLAUDE.md`, "avoid over-engineering").

## Versioning

The API uses URI versioning: all routes are prefixed `/api/v1/...`
(`CURRENT_API_VERSION` in `@playle/shared`). A new major version gets a new
prefix (`/api/v2/...`); existing versions are not broken in place.

## Standard Response Shapes

Errors use a single standard shape across the whole API (see
`packages/shared/src/http.ts` and
`apps/api/src/common/filters/http-exception.filter.ts`):

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Resource not found",
  "path": "/api/v1/health",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

Validation failures (`class-validator`) populate `message` as an array of
human-readable field errors.

**Exception**: `GET /health` does not use this error envelope even when it
returns a non-2xx status. It always returns its own
`{ status, timestamp, checks }` shape (200 when healthy, 503 when
degraded) by writing the response directly rather than throwing, because
it's an infra status report, not an API error — see
`apps/api/src/health/health.controller.ts` for why routing it through the
global exception filter would discard the actual postgres/redis status.

## Validation

Every endpoint's input is validated via a global `ValidationPipe`
(`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`).
Unknown properties are rejected, not silently dropped-and-ignored, to fail
loudly on client/server contract drift during development.

## Documentation

OpenAPI/Swagger is generated from the NestJS controllers/DTOs via
`@nestjs/swagger` and served in development at `GET /api/docs`
(JSON at `/api/docs-json`). Every endpoint (health, and now the
authentication endpoints below) has Swagger decorators (`@ApiTags`,
`@ApiOperation`, `@ApiResponse`, DTOs with `@ApiProperty`) as part of its
definition of done, not added retroactively — this remains the standard
for every endpoint added in future phases too.

## Authentication Endpoints (Phase 2)

Full architecture: [ADR-011](../decisions/ADR-011-authentication.md).

| Endpoint | Auth required | Notes |
|---|---|---|
| `POST /api/v1/auth/register` | No | Creates an account, returns tokens (auto-login). Stricter rate limit. |
| `POST /api/v1/auth/login` | No | `{ identifier, password }` — identifier is an email or phone number. Stricter rate limit. |
| `POST /api/v1/auth/refresh` | No (refresh token in body) | Rotates the refresh token; the old one stops working immediately. |
| `POST /api/v1/auth/logout` | Yes (Bearer) | Revokes the given refresh token. |
| `GET /api/v1/auth/me` | Yes (Bearer) | The authenticated user's own safe account info. |
| `POST /api/v1/auth/change-password` | Yes (Bearer) | Revokes every session on success — re-authentication required. |

`register` and `login` return the same shape:

```json
{
  "user": { "id": "...", "email": "...", "username": "...", "role": "USER", "status": "ACTIVE", "...": "..." },
  "accessToken": "ey...",
  "refreshToken": "opaque-random-string",
  "refreshTokenExpiresAt": "2026-01-31T00:00:00.000Z"
}
```

Never expect `passwordHash` or any refresh-token hash in a response —
`UsersService.toSafeUser()` strips it server-side before any response is
built.

Authenticated requests use `Authorization: Bearer <accessToken>`.
Protected routes return `401` for a missing/invalid/expired token and
`403` for a valid token whose role doesn't satisfy a `@Roles(...)`
requirement on that route.

## Wallet, Deposits & Withdrawals Endpoints (Phase 3)

Full architecture: [ADR-012](../decisions/ADR-012-financial-architecture.md),
[ADR-013](../decisions/ADR-013-payment-provider-abstraction.md). All
amounts in requests/responses are **decimal strings of integer minor
units** (1 SLE = 100 minor units) — e.g. `"50000"` = Le500.00 — never a
JSON number. All routes below require `Authorization: Bearer <accessToken>`
unless noted.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/wallet` | Own balances (`availableBalanceMinor`, `heldBalanceMinor`, `totalBalanceMinor`, `currency`). |
| `GET /api/v1/wallet/transactions` | Own ledger history, newest first, cursor-paginated. |
| `POST /api/v1/deposits` | Requires `Idempotency-Key` header. Minimum Le5 (`500` minor units), enforced server-side. |
| `GET /api/v1/deposits`, `GET /api/v1/deposits/:id` | Own deposits. |
| `POST /api/v1/withdrawals` | Requires `Idempotency-Key` header. Minimum Le5; holds the amount immediately (`availableBalanceMinor -= amount`, `heldBalanceMinor += amount`); requires admin approval before any payout. |
| `GET /api/v1/withdrawals`, `GET /api/v1/withdrawals/:id` | Own withdrawals. |
| `POST /api/v1/withdrawals/:id/cancel` | Only while `PENDING_REVIEW`; releases the hold. |
| `POST /api/v1/payments/webhooks/monime` | No auth guard (external caller) — authenticity via provider signature verification instead, which currently always rejects for the real Monime path (see ADR-013). |

A deposit only reaches `COMPLETED` (crediting the ledger) via a verified
provider event — never from a client call claiming success.

### Admin financial endpoints (require `role: 'ADMIN'`)

| Endpoint | Notes |
|---|---|
| `GET /api/v1/admin/wallets/:userId` | Any user's balances. |
| `GET /api/v1/admin/ledger?userId=` | Ledger entries, optionally filtered by user. |
| `GET /api/v1/admin/deposits`, `GET /api/v1/admin/withdrawals` | Optionally filtered by `userId`/`status`. |
| `POST /api/v1/admin/withdrawals/:id/approve` \| `/reject` \| `/complete` \| `/fail` | Each requires `{ reason }` (≥10 chars), recorded against the acting admin. |
| `POST /api/v1/admin/wallets/:userId/adjustments` | `{ direction: 'CREDIT'\|'DEBIT', amountMinor, reason }` — the **only** balance-editing path besides deposits/withdrawals; a `DEBIT` cannot drive the balance negative. |

## Phase 3 Scope

Authentication/identity (Phase 2) and wallet/ledger/deposits/withdrawals
(Phase 3, above) exist. Games, matchmaking, betting/prize-pool
settlement, social, and production Monime payments are not implemented
yet — see `CLAUDE.md` for the full "do not build yet" list.
