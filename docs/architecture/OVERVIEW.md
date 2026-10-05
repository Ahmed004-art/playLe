# Architecture Overview

## System Context

PlayLe is a social gaming platform with three applications sharing one
backend:

```
                     +-------------------+
                     |   PostgreSQL      |
                     |  (system of       |
                     |   record)         |
                     +---------+---------+
                               |
                     +---------+---------+        +----------------+
  Flutter mobile <-->|     NestJS API    |<------>|     Redis      |
  (Android/iOS)      |  (modular         |        | (cache, queues,|
                      |   monolith)       |        |  presence)     |
  Next.js admin  <-->|                   |
                      +---------+---------+
                               |
                      WebSocket gateway
                      (Socket.IO, server-
                       authoritative)
```

- **apps/mobile** (Flutter) — the player-facing app. Talks to the API over
  REST/HTTP (via OpenAPI-documented endpoints) and WebSockets for real-time
  match state.
- **apps/api** (NestJS) — the single backend. Server-authoritative for all
  game and financial state. PostgreSQL is the system of record; Redis holds
  ephemeral/shared state (queues, presence, locks, pub/sub).
- **apps/admin** (Next.js) — internal tool for staff to eventually view and
  manage users, matches, transactions, disputes, and system health. Talks
  to the same API.

## Why a Modular Monolith

See [ADR-001](../decisions/ADR-001-backend.md) and
[ADR-007](../decisions/ADR-007-monorepo.md). A single NestJS application
with clearly bounded modules (Auth, Users, Wallet, Ledger, Games,
Matchmaking, ...) gives most of the maintainability benefit of service
boundaries without the operational cost of distributed systems, at
PlayLe's current scale. Module boundaries are designed so any module could
be extracted into its own service later if real scale requires it.

## Core Architectural Commitments

1. **Server-authoritative game and financial state.**
   See [ADR-008](../decisions/ADR-008-server-authoritative.md). Clients
   never decide outcomes or balances; they send actions and render
   server-pushed state.
2. **Immutable, auditable financial ledger.**
   See [ADR-009](../decisions/ADR-009-financial-ledger.md). No financial
   operation is ever a bare mutable balance update.
3. **PostgreSQL as the single system of record**; Redis is disposable
   cache/ephemeral state, never the source of truth for money or match
   outcomes.
4. **Currency, match size, and game catalog are configuration/data, not
   hardcoded assumptions** — see
   [ADR-010](../decisions/ADR-010-platform-strategy.md) — so the platform
   can expand beyond Sierra Leone, beyond four players, and beyond
   PlayLe-native games without a rewrite.

## Implemented Modules

| Module | Responsibility |
|---|---|
| Auth | Registration, login, sessions (access/refresh tokens), guards — see [ADR-011](../decisions/ADR-011-authentication.md) |
| Users | Core user accounts, safe serialization |

## Future Module Boundaries (Not Yet Implemented)

The backend is expected to grow the following modules, built on the
foundation Phase 1 established (config, health, database, cache,
real-time, exception handling, validation) and the identity layer Phase 2
added:

| Module | Responsibility (future) |
|---|---|
| Profiles | Player-facing profile data beyond the basic Phase 2 fields |
| Social | Follows, friends, social graph |
| Games | Game catalog/definitions and rules |
| GameSessions | Live match/session state |
| Matchmaking | Queueing and opponent matching |
| Wallet | User balances (derived from Ledger) |
| Ledger | Immutable financial transaction log |
| Betting | Stake/prize-pool handling for a match |
| Payments | Mobile-money deposit integrations |
| Withdrawals | Withdrawal requests + admin approval workflow |
| Notifications | Push/in-app notifications |
| Chat | In-match/social messaging |
| Admin | Administrative operations and controls |
| Fraud | Fraud detection/review |
| Audit | Audit log of sensitive actions |
| Analytics | Platform/business analytics |

These are deliberately **not** scaffolded as empty NestJS modules in
Phase 1 — an empty, unimported module is dead code and would fail the
project's own "no unnecessary complexity" review criteria. They will be
created with real logic when their dedicated phase begins, following the
same module conventions as the Phase 1 modules described in
`PROJECT_STRUCTURE.md`.

## Real-Time Flow (Future)

See [GAME_ENGINE.md](GAME_ENGINE.md) for the full authoritative game loop
and [ADR-006](../decisions/ADR-006-realtime.md) for the WebSocket transport
decision. Phase 1 only implements connection lifecycle, not game events.

## Financial Flow (Future)

See [ADR-009](../decisions/ADR-009-financial-ledger.md) and
`docs/database/README.md`. Phase 1 only implements documentation, not the
schema or business logic.
