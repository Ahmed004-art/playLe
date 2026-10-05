# Database

## Stack

- **PostgreSQL** — system of record for all persistent data
  ([ADR-003](../decisions/ADR-003-database.md)).
- **Prisma** — ORM, schema definition, and migration tool
  ([ADR-004](../decisions/ADR-004-prisma.md)).

Schema lives at `apps/api/prisma/schema.prisma`. Migrations live at
`apps/api/prisma/migrations/`.

## Current Schema (Phase 2)

Two real domain models exist, added in Phase 2 — see
[ADR-011](../decisions/ADR-011-authentication.md) for the reasoning:

- **`User`** — the account record: `email` (unique), `phoneNumber`
  (unique, optional), `username` (unique), `passwordHash`, `role`
  (`USER`/`ADMIN`), `status` (`ACTIVE`/`SUSPENDED`/`DISABLED`),
  `dateOfBirth`, `emailVerifiedAt`/`phoneVerifiedAt` (both `null` until a
  future verification phase), `lastLoginAt`, `createdAt`/`updatedAt`.
  `passwordHash` must never be serialized into an API response — see
  `UsersService.toSafeUser()`.
- **`RefreshToken`** — session state supporting rotation and reuse
  detection: `tokenHash` (SHA-256 of the raw token — the raw token itself
  is never persisted), `familyId`, `revokedAt`, `replacedByHash`,
  `expiresAt`, plus `userAgent`/`ipAddress` for future session-management
  UI. Cascade-deletes with its `User`.

Phase 1's `schema.prisma` intentionally contained no business models;
connectivity was proven via a raw `SELECT 1` instead. That raw query is
still what the health check uses — `User`/`RefreshToken` are real
business models now, not a connectivity probe.

## Phase 2 Scope

Phase 2 establishes identity/session data only. It does not yet create
wallet, ledger, match, or social-graph tables — those are designed in
their own dedicated phases, informed by the financial ledger model in
[ADR-009](../decisions/ADR-009-financial-ledger.md).

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
- `prisma migrate dev` needs `CREATEDB` privilege (it creates a temporary
  shadow database to diff against) — the application's runtime database
  role should **not** have this privilege (least-privilege), so authoring
  a migration typically happens under a more-privileged role, then the
  resulting migration file is applied with `prisma migrate deploy` (which
  needs no shadow database) under the normal runtime role. This is
  standard practice, not a Phase 2-specific workaround.
- Migrations are committed to version control and applied via
  `prisma migrate deploy` in CI/staging/production, never
  `prisma db push` outside of local prototyping.
- Financial-related schema changes require particular care: additive,
  backward-compatible changes are preferred over destructive ones once
  real data exists.

## Future Schema Direction

See [ADR-009](../decisions/ADR-009-financial-ledger.md). The eventual
schema will include (non-exhaustive, designed in each dedicated phase):

- `Wallet` (derived/cached balance) + `LedgerEntry` (immutable, append-only)
- `Match`, `MatchPlayer`, `GameSession`
- `Deposit`, `Withdrawal`, `Refund`, `AdminAdjustment`
- `AuditLogEntry`
- Verification tokens/OTP records (email/SMS verification — not yet
  designed; `User.emailVerifiedAt`/`phoneVerifiedAt` already reserve the
  fields that will be set once this lands)

`User` and `RefreshToken` (above) are no longer "future" — they exist as
of Phase 2.
