# ADR-003: Primary Database — PostgreSQL

## Status
Accepted — Phase 1

## Context
PlayLe's core domain (accounts, matches, wallets, an immutable financial
ledger) requires strong transactional guarantees, relational integrity
(foreign keys between users, matches, and transactions), and the ability to
run complex queries for admin reporting and fraud review.

## Decision
Use **PostgreSQL** as the primary relational database for all persistent
application and financial data.

- ACID-compliant transactions are non-negotiable for financial operations
  (stakes, prize pools, fee calculation, withdrawals) — see ADR-009.
- Mature support for constraints, foreign keys, and row-level locking,
  which the future Ledger design depends on.
- Excellent ecosystem support in the Node.js/Prisma/NestJS stack.

## Alternatives Considered
- **MySQL** — also viable and ACID-compliant, but PostgreSQL's richer type
  system (enums, numeric precision for money, JSONB where needed) and
  stronger transactional isolation tooling make it the better fit for a
  financial ledger.
- **MongoDB / NoSQL** — explicitly rejected for core financial and
  relational data; document stores do not provide the multi-row
  transactional guarantees an auditable ledger requires. A NoSQL store may
  be considered later for non-financial, non-relational data (e.g.
  ephemeral presence), not as the system of record.

## Consequences
- The team commits to relational schema design and migrations (see
  ADR-004) for all core domains.
- Horizontal scaling of PostgreSQL requires deliberate strategy (read
  replicas, partitioning) if PlayLe grows significantly; not a Phase 1
  concern.
- No production schema is created in Phase 1; only the infrastructure
  (connection, migration tooling) is established.
