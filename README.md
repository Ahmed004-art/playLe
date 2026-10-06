# PlayLe

A Sierra Leone-first social gaming platform. Players create accounts,
connect with other players, find opponents through direct challenges or
matchmaking, and compete in real-money-staked matches (2, 3, or 4 players).
Stakes form a prize pool; PlayLe takes a 10% platform fee; the winner
receives the remaining 90%.

> **CURRENT PHASE: PHASE 5 — REAL-MONEY MATCH STAKES, HOLDS, PRIZE POOLS
> & DETERMINISTIC SETTLEMENT**
>
> Phases 1-4 (foundation, identity/authentication, wallet/ledger/financial
> foundation, game platform/matchmaking/real-time) are complete. Phase 5
> connects the two: players stake equal amounts (held via the Phase 3
> ledger), a completed match's authoritative result drives deterministic
> settlement — win payout minus a 10% platform fee to a real seeded
> platform account, draw/cancellation refunds, disconnect-forfeit
> settlement — with exactly-once guarantees, crash recovery, on-demand
> reconciliation, and a dispute foundation. See
> [ADR-016](docs/decisions/ADR-016-match-financial-architecture.md),
> [ADR-017](docs/decisions/ADR-017-deterministic-settlement.md), and
> [ADR-018](docs/decisions/ADR-018-financial-state-machines.md). Real
> money is exercised against test wallets only — no production Monime
> integration, no additional games, no social features. See "Roadmap"
> and `CLAUDE.md` for what's in scope.

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
  Tic-Tac-Toe** ✅ complete. A generic game-module contract/registry,
  match lifecycle and persistence, matchmaking, direct challenges,
  presence, and real-time push over Socket.IO, proven with one
  server-authoritative Tic-Tac-Toe game. See
  [ADR-014](docs/decisions/ADR-014-realtime-command-transport.md) and
  [ADR-015](docs/decisions/ADR-015-game-module-architecture.md).
- **Phase 5 — Real-Money Match Stakes, Holds, Prize Pools &
  Deterministic Settlement** (current). Equal-stake holds, prize pools,
  a 10% platform fee to a real seeded platform account, deterministic
  win/draw/cancellation/disconnect-forfeit settlement, exactly-once
  guarantees, crash recovery, on-demand reconciliation, and a dispute
  foundation. See
  [ADR-016](docs/decisions/ADR-016-match-financial-architecture.md),
  [ADR-017](docs/decisions/ADR-017-deterministic-settlement.md), and
  [ADR-018](docs/decisions/ADR-018-financial-state-machines.md). Real
  Monime payouts, KYC, and additional games remain out of scope.
- Later phases (not yet scheduled/implemented) are expected to cover, in
  order of dependency: production Monime payment-provider integration,
  additional games on the same game-module/financial contract, admin
  operational tooling, social features, and notifications. Each phase
  will be specified explicitly before implementation begins — see
  `CLAUDE.md`, "Phase Discipline".

## Contribution / Development Workflow

See [`docs/development/WORKFLOW.md`](docs/development/WORKFLOW.md) for the
full requirement -> implementation -> verification -> commit pipeline and
commit message conventions.
