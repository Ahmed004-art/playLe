# ADR-004: ORM — Prisma

## Status
Accepted — Phase 1

## Context
The backend needs type-safe database access from TypeScript, a reliable
migration system, and a workflow an implementation engineer can follow
deterministically across many future schema changes (users, wallets,
ledger, matches, social graph, etc.).

## Decision
Use **Prisma** as the ORM and migration tool for the NestJS API.

- Generates fully-typed query clients from `schema.prisma`, eliminating a
  class of runtime type errors when working across many models.
- `prisma migrate` gives a reviewable, versioned migration history, which
  is important for an auditable financial system.
- Strong NestJS community integration patterns (injectable `PrismaService`).

## Alternatives Considered
- **TypeORM** — more "magic" via decorators/active record patterns; Prisma's
  explicit schema file and generated client produce more predictable
  diffs and are easier to review for a single implementation engineer.
- **Knex / raw SQL query builder** — maximum control, but no generated
  types and a hand-rolled migration workflow; more error-prone for a
  project that must remain correct across many phases.

## Consequences
- The Prisma schema (`apps/api/prisma/schema.prisma`) becomes the single
  source of truth for the relational data model.
- Complex financial queries that need raw SQL performance tuning can still
  use `$queryRaw`, but the default is the generated client.
- Phase 1 establishes Prisma tooling and a minimal schema; the full
  business schema (wallet, ledger, matches, etc.) is designed in the
  dedicated database phase.
- **Pinned to Prisma 6.x, not 7.x**: Prisma 7 made `datasource.url` in
  `schema.prisma` a hard validation error, requiring a `prisma.config.ts`
  file and a driver-adapter object passed to the `PrismaClient`
  constructor instead. That's a deliberate, heavier architecture change
  not warranted for a Phase 1 foundation (see Section 31 of the project
  spec — avoid unnecessary complexity). `prisma`/`@prisma/client` are
  pinned to `6.19.3`, the latest version still supporting the
  conventional schema-based connection URL. Revisit deliberately, not
  accidentally, when upgrading later.
- The Prisma client generator uses its **default output location**
  (`node_modules/@prisma/client`), not a custom `output` path. A custom
  path under `apps/api/src/generated` was tried and reverted: `nest build`
  only compiles `.ts` files into `dist/`, so pre-built `.js`/`.d.ts`
  generated-client files placed under `src/` were never copied into
  `dist/`, and the compiled app crashed on boot with
  `ERR_MODULE_NOT_FOUND`. The default location resolves correctly via
  `node_modules` regardless of whether the importing code runs from
  `src/` (ts-node/Nest dev mode) or `dist/` (production build).
