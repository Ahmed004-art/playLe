# Project Structure

```
playle/
  apps/
    mobile/                   Flutter application (Android first, iOS-ready)
      lib/
        core/                 Cross-cutting foundations (env, DI, routing, theme, logging)
        features/             Feature modules (Phase 1: foundation/dev screen only)
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
        realtime/                WebSocket gateway foundation (connection lifecycle only)
      prisma/
        schema.prisma            Prisma schema (minimal in Phase 1)
        migrations/
      test/                      e2e tests

    admin/                     Next.js admin application
      src/
        app/                     App Router pages (dashboard shell only in Phase 1)
        lib/                     API client abstraction, config
        components/              Shared UI components

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
