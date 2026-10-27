# PlayLe

A Sierra Leone-first social gaming platform. Players create accounts,
connect with other players, find opponents through direct challenges or
matchmaking, and compete in real-money-staked matches (2, 3, or 4 players).
Stakes form a prize pool; PlayLe takes a 10% platform fee; the winner
receives the remaining 90%.

> **CURRENT PHASE: PHASE 12 — SOCIAL FOUNDATION**
>
> Phase 12 adds the social half of the product: player blocking, public
> profiles, friend requests, a friends list with presence, challenging
> friends, and a match-history screen. It changes no wallet, ledger,
> payment, settlement, eligibility, responsible-gaming or real-money
> behavior and adds no chat, feed, groups or followers. Design:
> [ADR-026](docs/decisions/ADR-026-social-foundation.md); plan and PR-by-PR
> status: [`PHASE_12_PLAN.md`](docs/development/PHASE_12_PLAN.md). PR 1
> (blocking), PR 2 (profiles, summaries, match statistics, block-aware
> lookup) and PR 3 (friends, friend requests, friend presence, realtime
> events) are merged; PR 4 (Flutter player profile and match history
> screens) is implemented and awaiting review - its Flutter checks have not
> been run; the friends/requests/blocked screens (PR 5) are not started.
>
> *Previous phase — Phase 11 (verification, security and engineering
> hardening):*
>
> Phase 11 builds no new game and changes no financial, eligibility or
> real-money behavior. It fixes verified narrow-screen/large-text defects
> in the shared match widgets (with tests), records a disposition for the
> eight `npm audit` findings (none fixable safely in scope — see
> [`PHASE_11_REPORT.md`](docs/development/PHASE_11_REPORT.md)), and adds
> the missing Phase 8/9/10 reports. Nothing here has been verified on an
> Android device.
>
> *Previous phase — Phase 10 (Dice; PR #1, merge commit `d051115`):*
>
> Phase 10 adds Dice, the platform's third game, as a new `GameModule`
> with no platform change (see
> [ADR-025](docs/decisions/ADR-025-dice-game-module.md)): two players,
> two dice per roll, best of three rounds, with tied rounds replayed and
> three consecutive ties ending the match as a draw. Rolls are generated
> server-side by a cryptographically secure RNG; they are **not**
> "provably fair" (there is no commit-reveal protocol). Dice is seeded
> **disabled**: implementing the game is not authorization to launch it,
> and real-money use of a pure game of chance needs owner legal and
> payment-provider confirmation first (see `OUTSTANDING_WORK.md`).
>
> *Previous phase — Phase 9 (match lifecycle integrity, matchmaking
> correctness & game result semantics):*
>
> Phases 1-8 (foundation, identity/authentication, wallet/ledger/
> financial foundation, game platform/matchmaking/real-time, match
> stakes/settlement/disputes/reconciliation, production Monime
> payment/account-security/eligibility foundations, a repository audit
> plus the Checkers game/shared mobile design system, and server-
> enforced rolling-window responsible-gaming limits) are complete.
> Phase 9 closed five previously-tracked outstanding-work items: a
> real, server-authoritative turn/move timer that survives API restarts
> and can never be bypassed by a racing move (the deadline is a real
> `Match` column, and expiry is processed under the exact same row lock
> a move submission already uses); matchmaking's `WAITING`-blind
> duplicate-match check, fixed with a new advisory-lock-based guard that
> closes the race between matchmaking and direct challenges (or two
> concurrent challenge-accepts) sharing a user, including explicit
> recovery when Redis's queue and Postgres's match state briefly
> disagree; resign and draw-offer commands, added through the existing
> command pipeline rather than a parallel mechanism; and richer
> terminal-outcome semantics (resignation/timeout/agreed-draw) added to
> the existing `MatchTerminationReason` column rather than any change to
> `GameResult` or `SettlementService`. See
> [ADR-024](docs/decisions/ADR-024-match-lifecycle-integrity.md) for the
> full design and rationale. Everything from Phase 6/7/8 (Monime,
> webhook verification, business eligibility, the deposit-limit
> concurrency limitation, and more) is unchanged and still tracked in
> `OUTSTANDING_WORK.md`. See "Roadmap" and `CLAUDE.md` for what's in
> scope, and the Phase 9 report for exact verification results and the
> CI run URL.

## Overview

- **Market**: Sierra Leone first, architected to expand further.
- **Currency**: Sierra Leonean Leone (SLE) initially.
- **Payments**: Sierra Leone mobile-money providers (deposits/withdrawals);
  withdrawals require admin approval initially.
- **Platforms**: Android first; iOS-ready architecture from day one.
- **Match sizes**: 2, 3, and 4 players initially; architected for more.
- **Games**: Tic-Tac-Toe is implemented as the reference game (Phase 4),
  Checkers followed in Phase 7, and Dice in Phase 10 (seeded disabled).
  Penalty, Ice Hockey, a G-Switch-style game, Ludo, Find the Marble, and
  support for organizing competitions around external games remain
  planned for later phases, built on the same generic game-module
  contract (see
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
  [ADR-013](docs/decisions/ADR-013-payment-provider-abstraction.md). The
  real Monime integration this unlocked arrived in Phase 6 — see
  [ADR-019](docs/decisions/ADR-019-production-payments.md) and
  `docs/development/MONIME_SETUP.md`.
- **Phase 4 — Game Platform Core, Matchmaking, Real-Time Multiplayer &
  Tic-Tac-Toe** ✅ complete. A generic game-module contract/registry,
  match lifecycle and persistence, matchmaking, direct challenges,
  presence, and real-time push over Socket.IO, proven with one
  server-authoritative Tic-Tac-Toe game. See
  [ADR-014](docs/decisions/ADR-014-realtime-command-transport.md) and
  [ADR-015](docs/decisions/ADR-015-game-module-architecture.md).
- **Phase 5 — Real-Money Match Stakes, Holds, Prize Pools &
  Deterministic Settlement** ✅ complete. Equal-stake holds, prize pools,
  a 10% platform fee to a real seeded platform account, deterministic
  win/draw/cancellation/disconnect-forfeit settlement, exactly-once
  guarantees, crash recovery, on-demand reconciliation, and a dispute
  foundation. See
  [ADR-016](docs/decisions/ADR-016-match-financial-architecture.md),
  [ADR-017](docs/decisions/ADR-017-deterministic-settlement.md), and
  [ADR-018](docs/decisions/ADR-018-financial-state-machines.md).
- **Phase 6 — Production Payment Integration, Financial Operations,
  Account Security & Responsible-Gaming Foundations** ✅ complete. A real
  Monime integration (Payment Codes for deposits, Payouts for
  withdrawals, status polling, provider-operation tracking, and a
  payment-reconciliation service distinct from Phase 5's match
  reconciliation); admin httpOnly session cookies with CSRF protection,
  replacing `localStorage`; password reset; email/phone verification;
  session listing/revocation; TOTP-based MFA; and a centralized
  real-money eligibility service with responsible-gaming limits,
  cooling-off, and (permanent, no-lift-path) self-exclusion. See
  [ADR-019](docs/decisions/ADR-019-production-payments.md),
  [ADR-020](docs/decisions/ADR-020-account-security.md), and
  [ADR-021](docs/decisions/ADR-021-eligibility-and-responsible-gaming.md).
  Webhook signature verification still fails closed pending one
  unverifiable Monime fact, so live payments aren't auto-confirmed yet;
  no real email/SMS delivery provider is integrated (a
  `FakeDeliveryAdapter` only) — see
  `docs/development/OUTSTANDING_WORK.md` for this and every other item
  still open.
- **Phase 7 — Repository Audit, Modern Game Design System &
  Production-Quality Checkers** ✅ complete. A verified repository audit;
  a shared mobile game design system (spacing/radius/motion tokens,
  board/piece/king colors, generic match chrome extracted out of
  Tic-Tac-Toe into reusable widgets); and a complete, server-
  authoritative Checkers game (mandatory capture, multi-jump
  continuation, king promotion, an explicit 40-move draw rule) — the
  platform's second game, requiring zero changes to matchmaking,
  challenges, the command pipeline, realtime, stake confirmation, or
  settlement. See
  [ADR-022](docs/decisions/ADR-022-checkers-game-module.md). Two
  pre-existing race conditions unrelated to Checkers (found during this
  phase's audit) were also fixed — see the Phase 7 report.
- **Phase 8 — Server-Enforced Responsible Gaming & Financial Safety**
  ✅ complete. Real rolling-window `STAKE_LIMIT`/`DEPOSIT_LIMIT`/
  `LOSS_LIMIT` enforcement, closing outstanding-work item 7 (previously
  a documented Phase 6 simplification): what counts as spending/a loss
  is drawn strictly from ledger entries and `SettlementEntry.role`, the
  check runs inside the existing wallet-locked stake-confirmation
  transaction (no new locking), and the rolling window length is a
  fixed platform parameter so it can't be shrunk to evade a limit. A
  real pre-existing gap — challenge-accept never checked the
  *opponent's* eligibility — was found and fixed. See
  [ADR-023](docs/decisions/ADR-023-rolling-window-responsible-gaming.md).
  Mobile and admin gained read-only visibility into current rolling
  usage against configured limits.
- **Phase 9 — Match Lifecycle Integrity, Matchmaking Correctness &
  Game Result Semantics** ✅ complete. Closed five previously-tracked
  outstanding-work items. A real, server-authoritative turn/move timer
  (`Game.turnTimeoutSeconds`/`Match.turnDeadlineAt`) enforced under the
  same row lock a move submission already uses, so a move racing a
  timeout sweep can never both win, and restart-safe/multi-instance-safe
  by construction (the deadline is a real column, not an in-memory
  timer). Matchmaking's `WAITING`-blind duplicate-match check fixed via
  a new `MatchesService.createMatchGuarded` — sorted Postgres advisory
  transaction locks closing the race between matchmaking and direct
  challenges (or two concurrent challenge-accepts) sharing a user, with
  explicit recovery when Redis's queue and Postgres's match state
  briefly disagree. Resign and draw-offer commands
  (`RESIGN`/`DRAW_OFFER`/`DRAW_ACCEPT`/`DRAW_REJECT`), added through the
  existing `MatchCommand` pipeline. Richer terminal-outcome semantics —
  `RESIGNATION`/`TURN_TIMEOUT`/`DRAW_AGREED` added to the existing
  `MatchTerminationReason` column, deliberately without touching the
  binary `GameResult` interface or `SettlementService`. See
  [ADR-024](docs/decisions/ADR-024-match-lifecycle-integrity.md).
- **Phase 10 — Dice** ✅ complete (PR #1, merge commit
  `d051115271ed795e6588fdd0de9498097406e536`; CI-verified, Chrome-preview
  inspected, **not** device-verified). The platform's third game, a new
  `GameModule` requiring no change to matchmaking, challenges, the
  command pipeline, realtime, stake confirmation, or settlement: two
  players, two dice per roll, best of three rounds, alternating
  starters, tied rounds replayed, and a draw after three consecutive
  ties. Rolls come from an injectable, cryptographically secure
  server-side RNG; the outcomes are not independently verifiable (no
  commit-reveal), so Dice is never described as "provably fair". Seeded
  **disabled** — launching it, and any real-money use, is a separate
  owner decision. See
  [ADR-025](docs/decisions/ADR-025-dice-game-module.md).
- **Phase 12 — Social Foundation** (current). Blocking, public profiles,
  friend requests, a friends list with presence, challenging friends and a
  match-history screen, delivered as five PRs. See
  [ADR-026](docs/decisions/ADR-026-social-foundation.md) and
  [`PHASE_12_PLAN.md`](docs/development/PHASE_12_PLAN.md) for status.
- **Phase 11 — Verification, Security and Engineering Hardening**
  (complete). No new game. Shared match widgets (`MatchStatusBar`,
  `MatchStakeStatusBar`, `DrawOfferBanner`, `FinancialResultBanner`) and
  the Dice roll rows no longer overflow on narrow screens or at large text
  scales, covered by a 320/390 px × 1.0/1.5/2.0× test matrix; the eight
  `npm audit` findings are dispositioned (not fixed — no patched `braces`
  exists, and the `deepmerge-ts` fix needs the Prisma 7 major); and the
  Phase 8, 9, 10 and 11 reports are written from Git/CI evidence. See
  [`PHASE_11_REPORT.md`](docs/development/PHASE_11_REPORT.md).
- Phases after 12 are not yet defined/scheduled. Each phase is specified
  explicitly before implementation begins — see `CLAUDE.md`, "Phase
  Discipline".

## Contribution / Development Workflow

See [`docs/development/WORKFLOW.md`](docs/development/WORKFLOW.md) for the
full requirement -> implementation -> verification -> commit pipeline and
commit message conventions.
