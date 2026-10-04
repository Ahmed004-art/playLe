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
