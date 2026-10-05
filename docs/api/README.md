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

## Phase 2 Scope

Authentication/identity endpoints exist (above). No other business API
(wallet, games, matchmaking, social, etc.) is implemented yet — see
`CLAUDE.md` for the full "do not build yet" list.
