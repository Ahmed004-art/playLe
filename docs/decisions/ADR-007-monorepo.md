# ADR-007: Repository Strategy — Monorepo

## Status
Accepted — Phase 1

## Context
PlayLe consists of three applications (mobile, api, admin) plus shared
TypeScript packages and infrastructure/docs that all evolve together,
especially in early phases where API contracts change frequently.

## Decision
Use a single **monorepo** (`playle/`) containing `apps/*`, `packages/*`,
`infrastructure/`, and `docs/`, using **npm workspaces** for the
TypeScript projects (`apps/api`, `apps/admin`, `packages/shared`,
`packages/config`). The Flutter app (`apps/mobile`) lives in the same
repository but outside the npm workspace, since Dart has its own package
manager (pub).

- Keeps API contract changes, backend implementation, and admin/mobile
  consumers reviewable in a single place and commit history.
- `packages/shared` lets `apps/api` and `apps/admin` share TypeScript
  types/constants without publishing an internal npm package.
- No build-system orchestrator (e.g. Nx, Turborepo) is introduced in
  Phase 1 — three npm-workspace projects plus one Flutter project do not
  yet justify that tooling overhead (see Section 31, "do not
  over-engineer"). Root `package.json` scripts delegate to each workspace.

## Alternatives Considered
- **Polyrepo (separate repositories per app)** — cleaner permission
  boundaries, but adds coordination overhead for a single implementation
  engineer working across tightly-coupled API contracts; rejected for
  current team size and phase.
- **Nx / Turborepo from day one** — provides caching and task graphs, but
  is unnecessary complexity at three TypeScript projects; can be
  introduced later if build times or task orchestration become a real
  problem.

## Consequences
- Root `package.json` workspaces must stay in sync with `apps/*` and
  `packages/*` directories.
- If build/task orchestration becomes painful as more modules are added,
  introducing Nx/Turborepo later remains straightforward since workspace
  boundaries already exist.
- Flutter tooling (`flutter`, `dart`) and Node tooling are both required
  on any machine that builds the full repository.
