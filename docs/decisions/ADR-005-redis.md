# ADR-005: Cache / Ephemeral State — Redis

## Status
Accepted — Phase 1

## Context
PlayLe will need fast, temporary, shared state that does not belong in the
system-of-record relational database: matchmaking queues, online presence,
in-progress (pre-settlement) game state, rate-limiting counters,
distributed locks, and pub/sub for multi-instance WebSocket fan-out.

## Decision
Use **Redis** as the shared cache and ephemeral-state store.

- Sub-millisecond operations suit matchmaking queues and presence.
- Built-in data structures (sorted sets, hashes, pub/sub) map naturally to
  queues, presence sets, and cross-instance event broadcasting.
- Mature Node.js client ecosystem and NestJS integration patterns.

## Alternatives Considered
- **In-memory (single Node process)** — fails as soon as the API runs more
  than one instance, which real-time matchmaking will require; rejected.
- **PostgreSQL for ephemeral state (e.g. LISTEN/NOTIFY, temp tables)** —
  usable in a pinch, but mixes ephemeral, high-churn data with the
  financial system of record; rejected in favor of a dedicated store.

## Consequences
- Redis becomes a required piece of local development infrastructure
  (see `infrastructure/docker`).
- Nothing in Redis is treated as durable or authoritative for financial
  data — the ledger remains exclusively in PostgreSQL.
- Phase 1 only establishes connection, health check, and graceful shutdown;
  no queues, presence, or pub/sub logic is implemented yet.
