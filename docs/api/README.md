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

## Validation

Every endpoint's input is validated via a global `ValidationPipe`
(`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`).
Unknown properties are rejected, not silently dropped-and-ignored, to fail
loudly on client/server contract drift during development.

## Documentation

OpenAPI/Swagger is generated from the NestJS controllers/DTOs via
`@nestjs/swagger` and served in development at `GET /api/docs`
(JSON at `/api/docs-json`). Phase 1 only documents the foundation endpoints
(health). Business endpoints are documented as they are implemented in
later phases — every new endpoint must have Swagger decorators
(`@ApiTags`, `@ApiOperation`, DTOs with `@ApiProperty`) as part of its
definition of done, not added retroactively.

## Phase 1 Scope

Only the health endpoint(s) exist. No business API (auth, users, wallet,
games, etc.) is implemented yet — see `CLAUDE.md` and the Phase 1
specification for the full "do not build yet" list.
