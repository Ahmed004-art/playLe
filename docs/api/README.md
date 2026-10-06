# API

## How Mobile and Admin Talk to the API

Both `apps/mobile` (Flutter) and `apps/admin` (Next.js) talk to `apps/api`
(NestJS) over:

- **REST over HTTPS** for request/response operations, documented via
  OpenAPI/Swagger (served at `/api/docs` in development — see
  `apps/api/src/main.ts`).
- **WebSockets (Socket.IO)** for real-time match/matchmaking/challenge
  push, per [ADR-006](../decisions/ADR-006-realtime.md) and
  [ADR-014](../decisions/ADR-014-realtime-command-transport.md)
  (implemented as of Phase 4 — see below).

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

## Game Platform & Matchmaking Endpoints (Phase 4)

Full architecture: [ADR-014](../decisions/ADR-014-realtime-command-transport.md),
[ADR-015](../decisions/ADR-015-game-module-architecture.md). All routes
below require `Authorization: Bearer <accessToken>` unless noted. A
match command (a move) travels over REST, not WebSocket — WebSocket is
used only for server→client push and for joining a match's room.

| Endpoint | Notes |
|---|---|
| `GET /api/v1/games` | The game catalog (currently one row: Tic-Tac-Toe). |
| `GET /api/v1/games/:id` | A single game's catalog entry. |
| `POST /api/v1/matchmaking/join` | `{ gameId }`. Returns `QUEUED` or, if an opponent was already waiting, `MATCHED` with the new `matchId` immediately. |
| `POST /api/v1/matchmaking/leave` | `{ gameId }`. Removes the caller from the queue. |
| `POST /api/v1/challenges` | `{ gameId, opponentUserId }`. Rejects self-challenge and a duplicate pending challenge between the same two users for the same game. |
| `GET /api/v1/challenges` | Own sent + received challenges. |
| `POST /api/v1/challenges/:id/accept` \| `/decline` \| `/cancel` | Atomic conditional transition (`PENDING` -> target status); exactly one of two concurrent accept attempts succeeds. Accept creates the `Match`. |
| `GET /api/v1/matches` | Own match history, cursor-paginated. |
| `GET /api/v1/matches/:id` | A single match, including players, state, and result. `404` (not `403`) for a non-participant. |
| `POST /api/v1/matches/:id/commands` | `{ commandId, payload }` — `commandId` is a client-generated UUID, the idempotency key; a retried submission with the same id returns the original result rather than reapplying the move. |

### Admin match endpoints (require `role: 'ADMIN'`)

| Endpoint | Notes |
|---|---|
| `GET /api/v1/admin/matches` | All matches, optionally filtered by `gameId`/`status`. |
| `GET /api/v1/admin/matches/:id` | A single match. Read-only — there is no endpoint to set or override a result; the server is the sole authority over outcomes (ADR-008). |

### WebSocket events (Socket.IO, server→client push only)

The client authenticates on connect via `handshake.auth.token` and
receives an explicit `connected` acknowledgment before it is safe to
emit anything else (closes a connect-vs-authentication race found during
Phase 4 testing). A client emits `match:join` with a `matchId` to
subscribe to that match's room; the server re-verifies real match
membership server-side before adding the socket to the room — it never
trusts the client's claim.

| Event | Payload | When |
|---|---|---|
| `connected` | `{ userId }` | Right after a successful authenticated connection. |
| `match:found` | `{ matchId }` | Pushed to both players' personal rooms when matchmaking forms a match. |
| `match:state` | `{ matchId }` | After any accepted command; the client re-fetches `GET /matches/:id` rather than trusting a pushed state blob. |
| `match:completed` | `{ matchId }` | When a match reaches a terminal status. |
| `challenge:received` / `challenge:resolved` | `{ challengeId }` | On challenge create / accept / decline / cancel / expire. |
| `player:left` / `player:reconnected` | `{ matchId, userId }` | On disconnect/reconnect of a match participant. |

No separate `stake_confirmed`/`settlement_completed` event exists
(Phase 5): a stake reaching `ACTIVE` already pushes `match:state`, and
settlement always follows a `match:completed` push — both already mean
"something changed, re-fetch" in this client, so the mobile/admin client
re-fetches `GET /matches/:id/financial` on either event rather than the
server maintaining a second, narrower set of financial-only events.

## Match Stakes, Settlement & Disputes Endpoints (Phase 5)

Full architecture: [ADR-016](../decisions/ADR-016-match-financial-architecture.md),
[ADR-017](../decisions/ADR-017-deterministic-settlement.md),
[ADR-018](../decisions/ADR-018-financial-state-machines.md). Stakes are
optional on matchmaking-join/challenge-create — omitting `stake` is
ordinary free play, unchanged from Phase 4. All amounts are decimal
strings of minor units, same convention as Phase 3.

| Endpoint | Notes |
|---|---|
| `POST /api/v1/matchmaking/join` | `{ gameId, stake?: { amountMinor, currency } }`. Only players requesting the identical stake are ever paired. |
| `POST /api/v1/challenges` | `{ gameId, opponentUserId, stake?: { amountMinor, currency } }`. The stake is immutable once set — accepting commits to exactly this amount. |
| `POST /api/v1/matches/:id/stake/confirm` | Holds the caller's stake for a `WAITING` financially-backed match. The match becomes `ACTIVE` once every player has confirmed. Idempotent and concurrency-safe. |
| `GET /api/v1/matches/:id/financial` | The match's `MatchStake` and `Settlement` (both `null` for free play). `404` for a non-participant. |
| `POST /api/v1/matches/:id/dispute` | `{ reason }` (≥10 chars). Only a completed/abandoned match you played in; rejects a duplicate open dispute. |
| `GET /api/v1/disputes` | The authenticated user's own disputes. |

A move submitted before every player has confirmed their stake, or
after the match ends, is rejected the same way as any other invalid
command (see Phase 4's `POST /matches/:id/commands`) — settlement
itself is never triggered by a client call; it is derived entirely from
the match's own authoritative result once it reaches a terminal state.

### Admin financial-match & dispute endpoints (require `role: 'ADMIN'`)

| Endpoint | Notes |
|---|---|
| `GET /api/v1/admin/matches/:id/financial` | Full financial detail for any match — stake, pool, fee, settlement, per-party entries. No participant restriction. Read-only. |
| `GET /api/v1/admin/disputes`, `GET /api/v1/admin/disputes/:id` | Optionally filtered by `status`. |
| `POST /api/v1/admin/disputes/:id/resolve` | `{ status, resolution }` (≥10 chars). Status + audit only — **never moves money**. An upheld dispute's actual correction, if any, is a separate call to the existing `POST /admin/wallets/:userId/adjustments`. |
| `GET /api/v1/admin/reconciliation/run` | Runs every anomaly check (orphaned holds, missing/duplicate/unbalanced settlements, wallet/ledger mismatches) now and returns the report. Never modifies any record. |

## Phase Scope

Authentication/identity (Phase 2), wallet/ledger/deposits/withdrawals
(Phase 3), the game platform/matchmaking/challenges/real-time layer
(Phase 4), and match stakes/settlement/disputes/reconciliation
(Phase 5, above) exist. Production Monime payment-provider integration,
additional games, and social features are not implemented yet — see
`CLAUDE.md` for the full "do not build yet" list.
