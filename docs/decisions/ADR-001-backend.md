# ADR-001: Backend Framework — NestJS + TypeScript

## Status
Accepted — Phase 1

## Context
PlayLe needs a server-authoritative backend capable of handling REST APIs,
real-time WebSocket communication for game sessions, background workers
(matchmaking, settlement), and strict financial correctness. The team needs
a framework that enforces modular boundaries so future domains (Wallet,
Ledger, Games, Matchmaking, Social, Admin) can be added without the codebase
collapsing into an unstructured pile of routes.

## Decision
Use **NestJS** with **TypeScript** in strict mode as the backend framework,
structured as a **modular monolith** (not microservices).

- Each domain (Auth, Users, Wallet, Games, etc.) is a Nest module with clear
  boundaries, enabling future extraction into separate services if real
  scale ever requires it.
- Native support for dependency injection, guards, interceptors, pipes, and
  WebSocket gateways (via `@nestjs/websockets` + Socket.IO) directly serves
  the project's authentication, validation, and real-time requirements.
- NestJS has first-class OpenAPI/Swagger integration, which is required for
  mobile/admin client contract generation.

## Alternatives Considered
- **Express (bare)** — more flexible but leaves module boundaries,
  validation, and DI entirely to convention; higher risk of architectural
  drift across a long-lived project with a single implementation engineer.
- **Fastify (bare)** — faster raw throughput, same structural risk as Express.
- **Microservices from day one** — explicitly rejected per project
  instructions; premature for current scale and adds operational overhead
  (service discovery, distributed tracing, inter-service auth) with no
  current benefit.

## Consequences
- Slightly more boilerplate than a minimal Express app, offset by long-term
  maintainability as the number of domains grows.
- The team commits to Nest's conventions (modules/providers/controllers),
  which constrains some structural freedom but keeps the codebase
  predictable across phases.
- Future extraction of a module (e.g. Wallet/Ledger) into its own service
  remains possible because module boundaries are already explicit.
