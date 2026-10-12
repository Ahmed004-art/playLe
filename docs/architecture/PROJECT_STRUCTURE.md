# Project Structure

```
playle/
  apps/
    mobile/                   Flutter application (Android first, iOS-ready)
      lib/
        core/                 Cross-cutting foundations: env, DI, routing, theme (colors/spacing/
                               radii/motion tokens — the shared game design system, Phase 7), logging,
                               auth, wallet, widgets (shared loading/error/empty states, Phase 7),
                               games (catalog), match (generic match-state controller + match/widgets/
                               — the generic match chrome shared by every game, extracted from
                               Tic-Tac-Toe in Phase 7), matchmaking, challenges, realtime (connection
                               manager + WebSocket client)
        features/             Feature modules: auth (welcome/login/register/account), wallet
                               (balance/deposit/withdraw), games (catalog/lobby/match screens),
                               tic_tac_toe and checkers (board + screen — the only game-specific UI
                               per game; see ADR-022 for Checkers)
      test/
      android/
      ios/

    api/                       NestJS backend (modular monolith)
      src/
        main.ts                 Bootstrap: global pipes/filters, Swagger, security, graceful shutdown
        app.module.ts            Root module
        config/                  Env schema + typed configuration
        common/                  Global filters, interceptors, pipes, DTOs
        health/                  Health check module (DB + Redis)
        prisma/                  PrismaService + module
        redis/                   Redis connection service + module
        realtime/                WebSocket gateway: authenticated connections, presence, match-room
                                  membership, server→client push (ADR-006, ADR-014)
        users/                   UsersService (safe serialization, lookups, username lookup endpoint)
        auth/                    Registration, login, sessions, guards — see ADR-011
        ledger/                  LedgerService — sole writer of wallet balances/ledger rows (ADR-012)
        wallet/                  Wallet balance + transaction-history reads
        payments/                PaymentProviderPort + Manual/Monime providers (ADR-013), real Monime
                                  HTTP calls + PaymentReconciliationService as of Phase 6 (ADR-019)
        deposits/                Deposit lifecycle + provider webhook handling
        withdrawals/             Withdrawal lifecycle + admin approval state machine
        games/                   Game catalog + GameModule/GameRegistry contract; tic-tac-toe/ and
                                  checkers/ each hold one game's pure rule logic — see ADR-015/ADR-022
        matches/                 Match lifecycle/persistence, command submission, timeout + recovery sweep
        matchmaking/             Redis-backed opponent queueing, atomic match formation, stake-tier queues
        challenges/              Direct player-to-player challenge create/accept/decline/cancel/expire
        system-account/          The seeded platform/system account's wallet lookup — see ADR-016
        match-stakes/            Stake eligibility/validation, confirming (holding) a stake, financial reads
        settlement/              Settlement math (pure) + SettlementService (the one settlement authority) +
                                  ReconciliationService — see ADR-017
        disputes/                Dispute create/list/resolve — status/audit only, never moves money
        admin/                   Financial admin visibility + withdrawal review, match visibility,
                                  financial-match inspection, dispute resolution, reconciliation trigger,
                                  provider-operation/event visibility, payment reconciliation (ADR-019)
        admin-auth/              httpOnly-cookie admin session login/refresh/logout/me — see ADR-020
        audit/                   AdminAuditService — append-only AdminAuditLog writer, dependency-free
                                  so AdminAuthModule/MfaModule can both use it without a cycle
        password-reset/          Single-use, hashed password-reset tokens; anti-enumeration — see ADR-020
        verification/            Email/phone one-time verification codes — see ADR-020
        mfa/                     Hand-rolled TOTP/HOTP (RFC 6238/4226), enrollment, login challenge,
                                  recovery codes — see ADR-020
        notifications/           DeliveryPort + FakeDeliveryAdapter — shared delivery abstraction,
                                  no real email/SMS provider — see ADR-020
        notification-outbox/     Financial/security notifications enqueued in the same transaction as
                                  their triggering ledger write, delivered by a separate sweep — ADR-019
        eligibility/             Centralized real-money eligibility (EligibilityService) + responsible-
                                  gaming limits/cooling-off/self-exclusion (ResponsibleGamingService,
                                  no lift path) — see ADR-021
      prisma/
        schema.prisma            Prisma schema (User, RefreshToken, Wallet, LedgerEntry, Deposit,
                                  Withdrawal, ProviderEvent, Game, Match, MatchPlayer, MatchCommand,
                                  Challenge, MatchStake, MatchStakePlayer, Settlement, SettlementEntry,
                                  Dispute, ProviderOperation, PaymentReconciliationAnomaly,
                                  PasswordResetToken, VerificationChallenge, MfaTotpCredential,
                                  MfaRecoveryCode, ResponsibleGamingRestriction, NotificationOutbox,
                                  AdminAuditLog)
        migrations/
      test/                      e2e tests (auth, wallet, matches, matchmaking, realtime, match-stakes,
                                  checkers, payments-phase6, admin session/MFA/password-reset/
                                  verification/responsible-gaming)

    admin/                     Next.js admin application
      src/
        app/                     App Router pages (dashboard, /login, /withdrawals, /wallets,
                                  /matches, /matches/[id] (incl. Phase 5 financial section),
                                  /disputes, /disputes/[id], /reconciliation)
        lib/                     API client (httpOnly-cookie + CSRF contract as of Phase 6 — see
                                  ADR-020; no more token-storage.ts), auth context, config,
                                  wallet/match/dispute/reconciliation types, formatting
        components/              Shared UI components (AuthGuard, HealthStatus)

  packages/
    shared/                   TS contracts/utilities shared between api <-> admin ONLY
    config/                   Shared TS tooling config (base tsconfig, prettier)

  infrastructure/
    docker/                   docker-compose for local PostgreSQL + Redis

  docs/
    architecture/             System design docs (this directory)
    api/                      API contract documentation
    database/                 Database/Prisma documentation
    decisions/                Architecture Decision Records (ADR-NNN)
    development/              Setup & workflow docs

  scripts/                    Dev convenience scripts
  .github/workflows/          CI pipelines
  CLAUDE.md                    Permanent development instructions
  README.md
```

## Why This Layout

- **`apps/*` vs `packages/*`**: `apps` are deployable applications;
  `packages` are libraries consumed by apps. Nothing in `packages` is ever
  deployed on its own.
- **`packages/shared` is TypeScript-only.** Flutter/Dart cannot consume it.
  See `CLAUDE.md`, "Cross-Language Architecture Note", and
  [ADR-002](../decisions/ADR-002-mobile.md).
- **`infrastructure/`** holds only local development infrastructure
  (Docker Compose for Postgres/Redis) in Phase 1. Cloud/production
  infrastructure is out of scope until a later phase.
- **`docs/decisions/`** holds ADRs — one file per significant, hard-to-reverse
  decision, each with Context / Decision / Alternatives / Consequences.
- Module boundaries inside `apps/api/src` follow NestJS conventions: each
  concern (config, health, prisma, redis, realtime) is its own module with
  its own directory, importable independently. Future business modules
  (Wallet, Ledger, Games, ...) will follow the same pattern when they are
  implemented (see `docs/architecture/OVERVIEW.md`).

## Where New Code Goes

| I'm adding... | It goes in... |
|---|---|
| A new backend domain module (Phase 2+) | `apps/api/src/<domain>/` |
| A Prisma model | `apps/api/prisma/schema.prisma` |
| A type/constant shared by api and admin | `packages/shared/src/` |
| A Flutter feature screen (Phase 2+) | `apps/mobile/lib/features/<feature>/` |
| A Flutter core abstraction (routing, DI, theme) | `apps/mobile/lib/core/` |
| An admin page | `apps/admin/src/app/` |
| A new ADR | `docs/decisions/ADR-0NN-<slug>.md` |
| Local dev infra | `infrastructure/docker/` |
