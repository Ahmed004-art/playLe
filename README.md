# PlayLe

A Sierra Leone-first social gaming platform. Players create accounts,
connect with other players, find opponents through direct challenges or
matchmaking, and compete in real-money-staked matches (2, 3, or 4 players).
Stakes form a prize pool; PlayLe takes a 10% platform fee; the winner
receives the remaining 90%.

> **CURRENT PHASE: PHASE 4 — GAME PLATFORM CORE, MATCHMAKING, REAL-TIME
> MULTIPLAYER & TIC-TAC-TOE REFERENCE GAME**
>
> Phases 1-3 (foundation, identity/authentication, wallet/ledger/financial
> foundation) are complete. Phase 4 adds the reusable multiplayer game
> platform — a generic game-module contract and registry, match
> lifecycle/persistence, matchmaking, direct challenges, presence, and
> real-time push over Socket.IO (commands travel over REST, pushes over
> WebSocket) — proven with one fully playable, server-authoritative
> Tic-Tac-Toe game. See
> [ADR-014](docs/decisions/ADR-014-realtime-command-transport.md) and
> [ADR-015](docs/decisions/ADR-015-game-module-architecture.md). Matches
> have **no stakes, holds, or prize pools** — the financial system from
> Phase 3 is untouched. No betting/prize-pool settlement, additional
> games, social features, chat, KYC, or user-to-user transfers are
> implemented yet. See "Roadmap" and `CLAUDE.md` for what's in scope.

## Overview

- **Market**: Sierra Leone first, architected to expand further.
- **Currency**: Sierra Leonean Leone (SLE) initially.
- **Payments**: Sierra Leone mobile-money providers (deposits/withdrawals);
  withdrawals require admin approval initially.
- **Platforms**: Android first; iOS-ready architecture from day one.
- **Match sizes**: 2, 3, and 4 players initially; architected for more.
- **Games**: Tic-Tac-Toe is implemented as the reference game (Phase 4).
  Dice, Checkers, Penalty, Ice Hockey, a G-Switch-style game, Ludo, Find
  the Marble, and support for organizing competitions around external
  games remain planned for later phases, built on the same generic
  game-module contract (see
  [ADR-015](docs/decisions/ADR-015-game-module-architecture.md)).

## Architecture

See [`docs/architecture/OVERVIEW.md`](docs/architecture/OVERVIEW.md) for
the full system design and [`docs/decisions/`](docs/decisions/) for the
reasoning behind each major technology choice (ADR-001 through ADR-010).

Core commitments:

- **Server-authoritative** game and financial state
  ([ADR-008](docs/decisions/ADR-008-server-authoritative.md)).
- **Immutable, auditable financial ledger** — never a bare mutable balance
  ([ADR-009](docs/decisions/ADR-009-financial-ledger.md),
  implemented per [ADR-012](docs/decisions/ADR-012-financial-architecture.md)).
- **Modular monolith** backend, not microservices
  ([ADR-001](docs/decisions/ADR-001-backend.md)).

## Technology Stack

| Layer | Technology |
|---|---|
| Mobile | Flutter + Dart |
| Backend | Node.js + TypeScript + NestJS |
| Database | PostgreSQL |
| ORM | Prisma |
| Real-time | WebSockets (Socket.IO) |
| Cache / ephemeral state | Redis |
| Admin | Next.js + TypeScript |
| API docs | OpenAPI / Swagger |
| CI | GitHub Actions |

## Repository Structure

```
playle/
  apps/
    mobile/    Flutter application (Android first, iOS-ready)
    api/       NestJS backend (modular monolith)
    admin/     Next.js admin dashboard
  packages/
    shared/    TS contracts/utilities shared between api and admin only
    config/    Shared TS tooling config
  infrastructure/
    docker/    Local dev infrastructure (PostgreSQL, Redis)
  docs/        Architecture, API, database, decisions, development docs
  scripts/     Dev convenience scripts
  .github/workflows/   CI
```

Full explanation: [`docs/architecture/PROJECT_STRUCTURE.md`](docs/architecture/PROJECT_STRUCTURE.md).

## Local Setup

Full instructions: [`docs/development/SETUP.md`](docs/development/SETUP.md).

```bash
npm install                                   # install TS workspace deps
npm run docker:up                             # start Postgres + Redis
cp apps/api/.env.example apps/api/.env
cp apps/admin/.env.example apps/admin/.env.local
npm run db:generate && npm run db:migrate
npm run dev:api                               # http://localhost:3000
npm run dev:admin                             # http://localhost:3001
```

```bash
cd apps/mobile
flutter pub get
flutter run
```

## Development Commands

```bash
npm run build          # build api + admin
npm run test             # test api + admin
npm run lint              # lint api + admin
npm run typecheck        # typecheck api + admin
npm run format             # format with Prettier
npm run db:generate       # regenerate Prisma client
npm run db:migrate        # run Prisma dev migrations
```

Flutter (from `apps/mobile`): `flutter analyze`, `flutter test`,
`flutter build apk --debug`.

## Testing

Each app has its own test suite:

- `apps/api` — unit tests + e2e/integration test foundation (Vitest).
- `apps/admin` — component/unit test foundation.
- `apps/mobile` — unit + widget tests (`flutter test`).

See [`docs/development/SETUP.md`](docs/development/SETUP.md) for exact
commands and [`docs/development/WORKFLOW.md`](docs/development/WORKFLOW.md)
for the definition of done for any change.

## CI

GitHub Actions (`.github/workflows/`) runs dependency installation,
TypeScript builds, backend tests/lint, Flutter analysis/tests, an Android
build, and the admin build/typecheck on every push/PR. Phase 1 does not
deploy anything.

## Architectural Principles

- Server authoritative, security first.
- Financial operations must be auditable (ledger, not a bare balance).
- Modular architecture; avoid premature microservices.
- Test before claiming completion.
- Avoid unnecessary dependencies and speculative abstractions.
- Do not implement future phases prematurely.

See `CLAUDE.md` for the full engineering and development rules that govern
this repository.

## Roadmap

- **Phase 1 — Foundation** ✅ complete. Repository structure, development
  environment, architectural scaffolding.
- **Phase 2 — Identity, Authentication & User Foundation** ✅ complete.
  Accounts, email/phone + password auth, access/refresh sessions, roles,
  basic profile. See [ADR-011](docs/decisions/ADR-011-authentication.md).
- **Phase 3 — Wallet, Ledger & Financial Foundation** ✅ complete. Unified
  wallet, immutable ledger, deposits, withdrawals with admin approval,
  idempotency, concurrency-safe balance updates, payment-provider
  abstraction. See
  [ADR-012](docs/decisions/ADR-012-financial-architecture.md) and
  [ADR-013](docs/decisions/ADR-013-payment-provider-abstraction.md). Real
  Monime (or other provider) integration is pending verified
  credentials/documentation — see `docs/development/MONIME_SETUP.md`.
- **Phase 4 — Game Platform Core, Matchmaking, Real-Time Multiplayer &
  Tic-Tac-Toe** (current). A generic game-module contract/registry,
  match lifecycle and persistence, matchmaking, direct challenges,
  presence, and real-time push over Socket.IO, proven with one
  server-authoritative Tic-Tac-Toe game. See
  [ADR-014](docs/decisions/ADR-014-realtime-command-transport.md) and
  [ADR-015](docs/decisions/ADR-015-game-module-architecture.md). No
  stakes, holds, or prize pools — matches and the financial system
  remain fully isolated.
- Later phases (not yet scheduled/implemented) are expected to cover, in
  order of dependency: betting/prize-pool settlement (wiring Phase 3's
  wallet into Phase 4's matches), additional games on the same
  game-module contract, admin operational tooling, social features, and
  notifications. Each phase will be specified explicitly before
  implementation begins — see `CLAUDE.md`, "Phase Discipline".

## Contribution / Development Workflow

See [`docs/development/WORKFLOW.md`](docs/development/WORKFLOW.md) for the
full requirement -> implementation -> verification -> commit pipeline and
commit message conventions.
