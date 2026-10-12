# Architecture Overview

## System Context

PlayLe is a social gaming platform with three applications sharing one
backend:

```
                     +-------------------+
                     |   PostgreSQL      |
                     |  (system of       |
                     |   record)         |
                     +---------+---------+
                               |
                     +---------+---------+        +----------------+
  Flutter mobile <-->|     NestJS API    |<------>|     Redis      |
  (Android/iOS)      |  (modular         |        | (cache, queues,|
                      |   monolith)       |        |  presence)     |
  Next.js admin  <-->|                   |
                      +---------+---------+
                               |
                      WebSocket gateway
                      (Socket.IO, server-
                       authoritative)
```

- **apps/mobile** (Flutter) — the player-facing app. Talks to the API over
  REST/HTTP (via OpenAPI-documented endpoints) and WebSockets for real-time
  match state.
- **apps/api** (NestJS) — the single backend. Server-authoritative for all
  game and financial state. PostgreSQL is the system of record; Redis holds
  ephemeral/shared state (queues, presence, locks, pub/sub).
- **apps/admin** (Next.js) — internal tool for staff to eventually view and
  manage users, matches, transactions, disputes, and system health. Talks
  to the same API.

## Why a Modular Monolith

See [ADR-001](../decisions/ADR-001-backend.md) and
[ADR-007](../decisions/ADR-007-monorepo.md). A single NestJS application
with clearly bounded modules (Auth, Users, Wallet, Ledger, Games,
Matchmaking, ...) gives most of the maintainability benefit of service
boundaries without the operational cost of distributed systems, at
PlayLe's current scale. Module boundaries are designed so any module could
be extracted into its own service later if real scale requires it.

## Core Architectural Commitments

1. **Server-authoritative game and financial state.**
   See [ADR-008](../decisions/ADR-008-server-authoritative.md). Clients
   never decide outcomes or balances; they send actions and render
   server-pushed state.
2. **Immutable, auditable financial ledger.**
   See [ADR-009](../decisions/ADR-009-financial-ledger.md). No financial
   operation is ever a bare mutable balance update.
3. **PostgreSQL as the single system of record**; Redis is disposable
   cache/ephemeral state, never the source of truth for money or match
   outcomes.
4. **Currency, match size, and game catalog are configuration/data, not
   hardcoded assumptions** — see
   [ADR-010](../decisions/ADR-010-platform-strategy.md) — so the platform
   can expand beyond Sierra Leone, beyond four players, and beyond
   PlayLe-native games without a rewrite.

## Implemented Modules

| Module | Responsibility |
|---|---|
| Auth | Registration, login, sessions (access/refresh tokens), guards — see [ADR-011](../decisions/ADR-011-authentication.md) |
| Users | Core user accounts, safe serialization, username lookup |
| Ledger | Immutable financial transaction log — the only writer of balance changes, see [ADR-012](../decisions/ADR-012-financial-architecture.md) |
| Wallet | User balances (derived from Ledger), transaction history |
| Payments | Payment-provider abstraction (Manual/Monime) — see [ADR-013](../decisions/ADR-013-payment-provider-abstraction.md) |
| Deposits | Deposit lifecycle, provider webhook handling |
| Withdrawals | Withdrawal requests + admin approval workflow |
| Games | Game catalog + the generic `GameModule`/`GameRegistry` contract — see [ADR-015](../decisions/ADR-015-game-module-architecture.md); two registered games as of Phase 7, Tic-Tac-Toe and Checkers (see [ADR-022](../decisions/ADR-022-checkers-game-module.md)) |
| Matches | Match lifecycle/persistence, command submission (moves), idempotency, concurrency-safe state transitions |
| Matchmaking | Redis-backed opponent queueing, atomic match formation |
| Challenges | Direct player-to-player challenge create/accept/decline/cancel/expire |
| Realtime | WebSocket gateway: authenticated connections, presence, match-room membership, server→client push — see [ADR-006](../decisions/ADR-006-realtime.md) and [ADR-014](../decisions/ADR-014-realtime-command-transport.md) |
| SystemAccount | The seeded platform/system account's wallet lookup — see [ADR-016](../decisions/ADR-016-match-financial-architecture.md) |
| MatchStakes | Stake eligibility/validation, confirming (holding) a player's stake, the combined financial read view |
| Settlement | The sole settlement authority (`SettlementService`) + on-demand reconciliation — see [ADR-017](../decisions/ADR-017-deterministic-settlement.md) |
| Disputes | Technical foundation for disputing a completed match's outcome — status/audit only, never moves money |
| Admin | Financial admin visibility + withdrawal review, match visibility, financial-match inspection, dispute resolution, provider-operation/event visibility, and payment reconciliation (narrow slices — not a general admin system yet) |
| AdminAuth | httpOnly-cookie admin session login/refresh/logout/me — the same `AuthService`/`TokenService` machinery, a different transport — see [ADR-020](../decisions/ADR-020-account-security.md) |
| Audit | `AdminAuditLog` — append-only record of admin session/security events, used by `CsrfGuard`/`AdminSessionController`/`MfaService` |
| PasswordReset | Single-use, hashed password-reset tokens; anti-enumeration — see ADR-020 |
| Verification | Email/phone one-time verification codes — the first real implementation of the Phase 2 `emailVerifiedAt`/`phoneVerifiedAt` placeholders — see ADR-020 |
| Mfa | Hand-rolled TOTP/HOTP (RFC 6238/4226) enrollment, login challenge, recovery codes — see ADR-020 |
| Notifications | `DeliveryPort`/`FakeDeliveryAdapter` — the shared delivery abstraction behind password reset, verification, and the financial notification outbox; no real email/SMS provider yet |
| NotificationOutbox | Financial/security notifications enqueued in the same transaction as their triggering ledger write, delivered by a separate sweep — see ADR-019 |
| Eligibility | Centralized real-money eligibility (`EligibilityService`) and responsible-gaming limits/cooling-off/self-exclusion (`ResponsibleGamingService`, no lift path) — see [ADR-021](../decisions/ADR-021-eligibility-and-responsible-gaming.md) |
| Payments (extended) | Real `MonimeProvider` (Payment Codes, Payouts, status polling) and `PaymentReconciliationService` (provider/ledger drift detection, distinct from Settlement's reconciliation) — see [ADR-019](../decisions/ADR-019-production-payments.md) |

## Future Module Boundaries (Not Yet Implemented)

The backend is expected to grow the following modules, built on the
foundation Phase 1 established (config, health, database, cache,
real-time, exception handling, validation), the identity layer Phase 2
added, the financial foundation Phase 3 added, the game platform Phase 4
added, the match-financial engine Phase 5 added, the production-
payments/account-security/eligibility foundation Phase 6 added, and the
design-system/second-game foundation Phase 7 added (`Notifications`/
`NotificationOutbox` and `Audit` moved out of this list in Phase 6 — see
"Implemented Modules" above; Phase 7 added no new top-level module —
see below):

| Module | Responsibility (future) |
|---|---|
| Profiles | Player-facing profile data beyond the basic Phase 2 fields |
| Social | Follows, friends, social graph |
| Chat | In-match/social messaging |
| Fraud | Fraud detection/review beyond the read-only reconciliation anomaly checks already implemented |
| Analytics | Platform/business analytics |

Additional games beyond Tic-Tac-Toe and Checkers are new `GameModule`
implementations registered into the existing `Games`/`Matches` modules,
not new top-level modules — Checkers itself (Phase 7) is the proof: it
added `src/games/checkers/` and one line in `GamesModule`'s
registration array, nothing else. Likewise, a future production
payment-provider integration extends `Payments`/`Settlement`, not a new
module.

These are deliberately **not** scaffolded as empty NestJS modules in
Phase 1 — an empty, unimported module is dead code and would fail the
project's own "no unnecessary complexity" review criteria. They will be
created with real logic when their dedicated phase begins, following the
same module conventions as the Phase 1 modules described in
`PROJECT_STRUCTURE.md`.

## Real-Time Flow

See [GAME_ENGINE.md](GAME_ENGINE.md) for the full authoritative game loop,
[ADR-006](../decisions/ADR-006-realtime.md) for the original WebSocket
transport decision, and
[ADR-014](../decisions/ADR-014-realtime-command-transport.md) for the
Phase 4 refinement: a match command (e.g. a move) travels over REST,
reusing the same `JwtAuthGuard`/DTO-validation/idempotency pipeline as
every other mutating endpoint; the server then pushes the resulting
state to both players over the Socket.IO gateway. WebSocket is used
exclusively for server→client push (`match:state`, `match:completed`,
`match:found`, `challenge:received`, etc.) and for a client to join a
match's room (`match:join`) after REST has already confirmed membership
— the gateway never trusts a client's claim to be in a given match.

## Financial Flow

See [ADR-009](../decisions/ADR-009-financial-ledger.md),
[ADR-012](../decisions/ADR-012-financial-architecture.md),
[ADR-013](../decisions/ADR-013-payment-provider-abstraction.md),
[ADR-016](../decisions/ADR-016-match-financial-architecture.md),
[ADR-017](../decisions/ADR-017-deterministic-settlement.md),
[ADR-019](../decisions/ADR-019-production-payments.md), and
`docs/database/README.md`. Wallet, ledger, deposits, and withdrawals
(Phase 3) are now connected to matches (Phase 4) by Phase 5: a
`MatchStake` holds each player's equal stake through `LedgerService`;
`SettlementService` is the one place a completed match's authoritative
result becomes a win payout (minus a 10% platform fee to the seeded
platform account), a draw refund, or a cancellation refund. Phase 6
connected the deposit/withdrawal side to a real payment provider:
`MonimeProvider` issues Payment Codes for deposits and submits Payouts
for withdrawals (test-mode-exercisable today), and
`PaymentReconciliationService` runs read-only drift checks between the
ledger and provider state — deliberately separate from
`SettlementService`'s own reconciliation, which only ever checks
match-stake/settlement consistency. A *live* Monime deposit/payout
still can't be automatically confirmed until webhook signature
verification is resolved (fail-closed — see ADR-019).
