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

**Current phase: Phase 6 — Production Payment Integration, Financial
Operations, Account Security & Responsible-Gaming Foundations.**
See `docs/development/WORKFLOW.md` for the phase pipeline,
[ADR-019](docs/decisions/ADR-019-production-payments.md) for the real
Monime payment/payout/webhook/reconciliation architecture,
[ADR-020](docs/decisions/ADR-020-account-security.md) for admin session
cookies, CSRF, password reset, verification, and MFA, and
[ADR-021](docs/decisions/ADR-021-eligibility-and-responsible-gaming.md)
for the centralized real-money eligibility and responsible-gaming
foundation. Phase 1 (foundation), Phase 2 (identity/authentication),
Phase 3 (wallet/ledger/financial foundation), Phase 4 (game platform/
matchmaking/real-time), and Phase 5 (match stakes, settlement,
disputes, reconciliation) are complete. Phase 6's backend, account
security, and eligibility/responsible-gaming work is implemented and
tested (unit + e2e, passing locally against a real Postgres instance),
and the admin frontend has been migrated off `localStorage` to the new
cookie contract and verified: a real Monime integration (Payment Codes
for deposits, Payouts for withdrawals, status polling, provider-
operation tracking, and a separate payment-reconciliation service),
admin httpOnly session cookies with CSRF protection, password reset,
email/phone verification (via a `FakeDeliveryAdapter` only — see "What
NOT to Build Yet" below), session management, TOTP-based MFA, and a
centralized `EligibilityService` with responsible-gaming limits/
cooling-off/self-exclusion. CI has not yet been updated/re-verified for
this phase — that is tracked separately and is not yet done.

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
`docs/decisions/ADR-009-financial-ledger.md` for the full model,
[ADR-012](docs/decisions/ADR-012-financial-architecture.md) for its
Phase 3 implementation (`LedgerService.applyEntry`), and
[ADR-016](docs/decisions/ADR-016-match-financial-architecture.md)/
[ADR-017](docs/decisions/ADR-017-deterministic-settlement.md) for the
Phase 5 implementation (`SettlementService.settle`, which is what now
actually produces `PRIZE`/`PLATFORM_FEE` ledger entries — fee rounding is
`floor(pool * 10 / 100)` in `BigInt`). Real-money gaming is gated by
`REAL_MONEY_GAMING_ENABLED` (default `false`), a separate real-money
minimum age distinct from the general account age gate, and — as of
Phase 6 — a second independent `ELIGIBILITY_POLICY_CONFIGURED` flag, all
checked through the single centralized `EligibilityService` (see
[ADR-021](docs/decisions/ADR-021-eligibility-and-responsible-gaming.md)).
Phase 6's `PaymentReconciliationService` (`src/payments/`) is a
deliberately separate concern from Phase 5's `SettlementService`/
`ReconciliationService` (`src/settlement/`) — the former only ever
checks provider/ledger drift on deposits and withdrawals, the latter
only ever checks match-stake/settlement consistency; neither touches
the other's records (see
[ADR-019](docs/decisions/ADR-019-production-payments.md)).

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

## What NOT to Build Yet (Phase 6)

A *live* production Monime payment-provider integration, actual
mobile-money payouts, and real inbound-webhook authenticity: Phase 6
implemented a real `MonimeProvider` against verified Monime
documentation (Payment Codes for deposits, Payouts for withdrawals,
status polling), but `MonimeProvider.verifyWebhookSignature` still
always returns invalid — the exact HMAC canonical string Monime signs
is not independently verifiable yet — so no live deposit/payout can be
automatically confirmed via webhook until that is resolved (see
[ADR-019](docs/decisions/ADR-019-production-payments.md) and
`docs/development/MONIME_SETUP.md`). Also not yet built: KYC/AML
provider integration, additional games beyond Tic-Tac-Toe (the
financial pipeline is generic enough to support them without changes —
see ADR-016/017 — but none are implemented), social networking/
followers, premium subscriptions, advertising, ratings/rankings, fraud
systems, real email/SMS delivery (Phase 6 added the password-reset/
verification/MFA flows themselves, but delivery goes only through a
`FakeDeliveryAdapter` — no real provider credentials exist — see
ADR-020), rolling-window spend tracking and loss-limit enforcement
beyond the per-action ceilings `ResponsibleGamingService` already
enforces (see
[ADR-021](docs/decisions/ADR-021-eligibility-and-responsible-gaming.md)),
any self-exclusion-lift process, and a general admin operations system
beyond the narrow slices in `src/admin/`/`src/eligibility/` (financial
visibility from Phase 3, match visibility from Phase 4, financial-match
inspection and dispute resolution from Phase 5, payment-reconciliation
and responsible-gaming visibility from Phase 6 — no "set winner"/"give
player money"/"set balance"/"lift self-exclusion" shortcut of any
kind). See `README.md` roadmap for the full list. These belong to
later, explicitly approved phases.

## Stop Conditions

Stop and report rather than deciding unilaterally when you encounter:

- A major architectural decision not covered by an existing ADR.
- A conflict between this file and the current phase specification.
- A requirement to implement functionality explicitly listed as
  out-of-scope for the current phase.

Small implementation decisions (e.g. a specific library version, a file
naming convention) may be made without stopping.
