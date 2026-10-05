# CLAUDE.md — PlayLe Development Instructions

This file is the permanent development instruction file for Claude Code (or
any engineer/agent) working on this repository. Read it before implementing
any phase.

## Project Identity

**PlayLe** — a Sierra Leone-first social gaming platform. Users create
accounts, connect with other players, find opponents via direct challenge or
matchmaking, and compete in real-money-staked matches (2, 3, or 4 players).
Stakes form a prize pool; PlayLe takes a 10% platform fee; the winner
receives the remaining 90%. Initial currency is the Sierra Leonean Leone
(SLE), with deposits/withdrawals via Sierra Leone mobile-money providers.
Withdrawals initially require administrator approval. Android ships first;
the architecture keeps iOS buildable from day one. The platform is designed
to expand beyond Sierra Leone, beyond four players, and beyond
PlayLe-native games (e.g. organizing competitions around external games).

## Product Principles

- Social + gaming
- Real-money competitive matches
- Sierra Leone first
- Modern, premium UX
- Android first, iOS-ready
- Expandable beyond Sierra Leone
- Expandable beyond four players
- Expandable to external games

## Engineering Principles

- **Server authoritative** — the server is the sole authority over game
  state and financial state; clients send actions and render pushed state
  (see [ADR-008](docs/decisions/ADR-008-server-authoritative.md)).
- **Security first** — validate everything at system boundaries, never
  trust client input for anything financial or game-outcome-related.
- **Financial operations must be auditable** — immutable ledger, never a
  bare mutable balance (see
  [ADR-009](docs/decisions/ADR-009-financial-ledger.md)).
- **Database transactions for financial operations** — every financial
  write is atomic and idempotent.
- **Modular architecture** — a modular monolith with clear module
  boundaries, not microservices (see
  [ADR-001](docs/decisions/ADR-001-backend.md),
  [ADR-007](docs/decisions/ADR-007-monorepo.md)).
- **Test before claiming completion** — never report a feature as working
  without having actually run the relevant tests/build.
- **Avoid premature microservices.**
- **Avoid unnecessary dependencies.**
- **Do not implement future phases prematurely.**

## Development Rules

Claude Code (or any contributor) must:

1. Read the relevant documentation (`docs/architecture`, `docs/decisions`)
   before implementing a phase.
2. Inspect existing code before modifying it.
3. Follow the current phase specification — do not add functionality from
   a later phase "while you're in there."
4. Run appropriate tests after changes.
5. Run builds/type checks/static analysis after changes.
6. Report failures honestly. Never claim something passed without having
   run it. If something cannot be verified in this environment, say
   `NOT VERIFIED` and explain why.
7. Avoid unrelated refactoring.
8. Avoid silently changing architecture — if a major undocumented decision
   is required, stop and report it instead of deciding unilaterally.
9. Update documentation (`docs/`, relevant ADRs) when architecture changes.
10. Stop when the current phase's definition of done is met rather than
    automatically starting the next phase.

## Phase Discipline

The project is developed **sequentially, phase by phase**. Each phase has
an explicit specification and an explicit "do not build yet" list. Do not
implement a future phase's functionality early, even if it looks small or
convenient. The active phase must always be explicitly identified (see
`README.md`, "Current Phase").

**Current phase: Phase 4 — Game Platform Core, Matchmaking, Real-Time
Multiplayer & Tic-Tac-Toe Reference Game.**
See `docs/development/WORKFLOW.md` for the phase pipeline,
[ADR-014](docs/decisions/ADR-014-realtime-command-transport.md) for the
REST-commands/WS-push transport decision, and
[ADR-015](docs/decisions/ADR-015-game-module-architecture.md) for the
generic game-module/registry architecture. Phase 1 (foundation/scaffold),
Phase 2 (identity/authentication), and Phase 3 (wallet/ledger/financial
foundation) are complete. Phase 4 deliberately does not touch the
financial system — matches have no stakes, holds, or prize pools yet; see
"What NOT to Build Yet" below.

## Repository Structure

See [docs/architecture/PROJECT_STRUCTURE.md](docs/architecture/PROJECT_STRUCTURE.md)
for the full layout and the reasoning behind it.

```
playle/
  apps/
    mobile/   Flutter app (Android first, iOS-ready)
    api/      NestJS backend (modular monolith)
    admin/    Next.js admin dashboard
  packages/
    shared/   TS contracts/utilities shared between api and admin only
    config/   Shared TS tooling config (tsconfig base, prettier)
  infrastructure/
    docker/   Local dev infrastructure (PostgreSQL, Redis)
  docs/
    architecture/   System design docs
    api/            API contract docs
    database/       Database/Prisma docs
    decisions/       ADRs
    development/    Setup & workflow docs
  scripts/
  .github/workflows/  CI
```

## Technology Stack

| Layer | Technology |
|---|---|
| Mobile | Flutter + Dart (null safety) |
| Backend | Node.js + TypeScript + NestJS (modular monolith) |
| Database | PostgreSQL |
| ORM | Prisma |
| Real-time | WebSockets (Socket.IO via `@nestjs/websockets`) |
| Cache / ephemeral state | Redis |
| Admin | Next.js + TypeScript |
| API docs | OpenAPI / Swagger |
| VCS | Git + GitHub |
| CI | GitHub Actions |

Rationale for each choice is recorded in `docs/decisions/ADR-001` through
`ADR-010`.

## Cross-Language Architecture Note

Flutter/Dart cannot directly consume TypeScript packages. `packages/shared`
is for contracts/utilities shared **between the TypeScript applications
only** (`apps/api` ↔ `apps/admin`). Cross-platform API contracts for the
mobile app flow through OpenAPI (Swagger) and Dart models — hand-written in
early phases, potentially generated later. Do not attempt to share
TypeScript code directly with Flutter, and do not over-engineer code
generation before it's needed.

## Financial Rule (read before touching anything money-related)

For an N-player match where every player stakes the same amount:

```
prize pool = sum of all stakes
platform fee = 10% of prize pool
winner payout = 90% of prize pool
```

Example (2 players, Le100 each): prize pool = Le200, fee = Le20, winner
receives Le180. The same 10% fee model applies to 3- and 4-player matches.

**Never implement financial operations as a simple mutable balance
calculation.** Every financial operation must go through an auditable,
append-only ledger inside an atomic database transaction. See
`docs/decisions/ADR-009-financial-ledger.md` for the full model and
[ADR-012](docs/decisions/ADR-012-financial-architecture.md) for its
Phase 3 implementation (`LedgerService.applyEntry`). The specific
prize-pool/platform-fee math above is still documentation-only — betting
settlement is a future phase; Phase 3 only reserves the `PRIZE`/
`PLATFORM_FEE` ledger types for it.

## Commands

See `docs/development/SETUP.md` for full setup instructions and
`docs/development/WORKFLOW.md` for the day-to-day workflow. Quick reference:

```bash
npm install                 # install all TS workspace dependencies
npm run docker:up           # start PostgreSQL + Redis for local dev
npm run dev:api             # run the NestJS API in watch mode
npm run dev:admin           # run the Next.js admin app
npm run build                # build api + admin
npm run test                 # test api + admin
npm run lint                 # lint api + admin
npm run typecheck            # typecheck api + admin
npm run format                # format with Prettier
npm run db:generate          # generate Prisma client
npm run db:migrate           # run Prisma migrations (dev)
```

Flutter (from `apps/mobile`):

```bash
flutter pub get
flutter analyze
flutter test
flutter build apk --debug
```

## What NOT to Build Yet (Phase 4)

Real-money betting, stakes, wallet deductions/holds for matches, prize
pools, `PLATFORM_FEE`/`PRIZE` ledger entries (the types remain reserved
but still unproduced), Monime integration, any change to
deposits/withdrawals, user-to-user transfers, KYC/AML/tax, premium
subscriptions, social feed/followers, additional games beyond
Tic-Tac-Toe, ratings/rankings, fraud systems, and a general admin
operations system beyond the narrow read-only slices in `src/admin/`
(financial visibility from Phase 3, match visibility from Phase 4 — no
"set winner" override of any kind). Real Monime (or any other)
payment-provider integration is also not implemented — see
[ADR-013](docs/decisions/ADR-013-payment-provider-abstraction.md) and
`docs/development/MONIME_SETUP.md`. Email/SMS verification has a schema
placeholder (`emailVerifiedAt`/`phoneVerifiedAt`) but no provider
integration or OTP flow — see
[ADR-011](docs/decisions/ADR-011-authentication.md). See `README.md`
roadmap for the full list. These belong to later, explicitly approved
phases.

## Stop Conditions

Stop and report rather than deciding unilaterally when you encounter:

- A major architectural decision not covered by an existing ADR.
- A conflict between this file and the current phase specification.
- A requirement to implement functionality explicitly listed as
  out-of-scope for the current phase.

Small implementation decisions (e.g. a specific library version, a file
naming convention) may be made without stopping.
