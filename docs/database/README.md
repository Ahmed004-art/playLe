# Database

## Stack

- **PostgreSQL** — system of record for all persistent data
  ([ADR-003](../decisions/ADR-003-database.md)).
- **Prisma** — ORM, schema definition, and migration tool
  ([ADR-004](../decisions/ADR-004-prisma.md)).

Schema lives at `apps/api/prisma/schema.prisma`. Migrations will live at
`apps/api/prisma/migrations/` once the first one is created — that
directory does not exist yet in Phase 1, since there is no business
schema to migrate. `prisma migrate deploy` against zero migrations
succeeds trivially ("No pending migrations to apply"), which is the
correct, verified behavior for this phase, not an error condition.

## Phase 1 Scope

Phase 1 establishes the **connection, migration tooling, and workflow**
only. It does not create the business schema (users, wallets, ledger,
matches, social graph, etc.) — that is designed in the dedicated database
phase, informed by the financial ledger model in
[ADR-009](../decisions/ADR-009-financial-ledger.md).

Phase 1's `schema.prisma` intentionally contains no business models.
Database connectivity is proven via a raw query (`SELECT 1`) from the
health check module, not via a domain table.

## Local Development Database

Provided by Docker Compose (`infrastructure/docker/docker-compose.yml`).
See `docs/development/SETUP.md` for exact commands.

- Host: `localhost`
- Port: `5432` (configurable via `.env`)
- Database: `playle_dev`
- Credentials: see `apps/api/.env.example` (local-development-only values)

## Test Database Strategy

Integration tests that need a real database point `DATABASE_URL` at a
separate database (`playle_test`) rather than the development database, so
test runs never pollute local dev data. In CI, a PostgreSQL service
container provides this. Locally, create it once:

```bash
# with the dev Postgres container running
docker exec -it playle-postgres createdb -U playle playle_test
```

Tests that don't need real persistence should not spin up the database at
all (pure unit tests). Only integration/e2e tests use the test database.

## Common Commands

Run from the repo root (delegates to `apps/api`) or from `apps/api`
directly:

```bash
npm run db:generate          # regenerate the Prisma client after a schema change
npm run db:migrate           # create + apply a dev migration
npm run db:migrate:deploy    # apply existing migrations (CI/staging/prod)
npm run db:studio            # open Prisma Studio
```

## Migration Discipline

- Every schema change goes through `prisma migrate dev` so it produces a
  reviewable migration file — never hand-edit the database out-of-band in
  a way Prisma doesn't know about.
- Migrations are committed to version control and applied via
  `prisma migrate deploy` in CI/staging/production, never
  `prisma db push` outside of local prototyping.
- Financial-related schema changes require particular care: additive,
  backward-compatible changes are preferred over destructive ones once
  real data exists.

## Future Schema Direction

See [ADR-009](../decisions/ADR-009-financial-ledger.md). The eventual
schema will include (non-exhaustive, designed in the database phase):

- `User`, `Profile`
- `Wallet` (derived/cached balance) + `LedgerEntry` (immutable, append-only)
- `Match`, `MatchPlayer`, `GameSession`
- `Deposit`, `Withdrawal`, `Refund`, `AdminAdjustment`
- `AuditLogEntry`

None of these exist yet.
