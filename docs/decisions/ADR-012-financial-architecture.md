# ADR-012: Financial Architecture — Wallet, Ledger, Money Representation, Concurrency

## Status
Accepted — Phase 3 (implemented)

## Context
Phase 3 makes ADR-009's "wallet + immutable ledger" commitment concrete:
a real `Wallet`/`LedgerEntry`/`Deposit`/`Withdrawal`/`ProviderEvent`
schema, real money, and real concurrency control, built to safely
support future game/betting settlement without redesign.

## Decisions

### Money representation
1 SLE (Sierra Leonean Leone) = 100 minor units, matching ordinary decimal
currency practice. All monetary fields are `BigInt`/Postgres `bigint`,
named with a `Minor` suffix (e.g. `availableBalanceMinor`). Money is
**never** a float anywhere in the system — not in the database, not in
application code, not on the wire.

On the wire (API requests/responses), amounts are **decimal strings** of
integer minor units (e.g. `"50000"`), never JSON numbers — `JSON.stringify`
cannot serialize a `bigint`, and large integers don't round-trip safely
through JS/Dart `number`/`double`. `src/common/money.ts` is the single
place that converts between the two; `IsAmountMinorString` is the shared
DTO validator. Mobile/admin clients format for display only (`BigInt`
arithmetic client-side too — see `money_format.dart`/`money-format.ts`);
they never compute with the value as a floating-point number.

### Wallet model
One unified `Wallet` per `User` (`availableBalanceMinor`,
`heldBalanceMinor`, `currency`), created atomically at registration time
(`AuthService.register`) — no code elsewhere has to handle "wallet
doesn't exist yet." No separate "deposited" vs "winnings" balance, per
spec.

### Ledger model
`LedgerEntry` is immutable and append-only. One row represents one atomic
business event and can move both buckets at once (e.g. a `HOLD` is
simultaneously `availableDeltaMinor: -N, heldDeltaMinor: +N` in a single
row) — this is simpler and exactly as auditable as forcing two
single-polarity rows per operation, while directly answering "resulting
financial state" via the `*BalanceAfterMinor` snapshot columns.
`LedgerEntryType` includes `PRIZE`/`PLATFORM_FEE` as reserved-but-unused
values for forward compatibility with the future betting-settlement
phase; Phase 3 code never produces them.

**`LedgerService.applyEntry` is the only method in the codebase permitted
to write a `Wallet` balance or a `LedgerEntry` row.** No other service may
call `wallet.update(...)` or `ledgerEntry.create(...)` directly. This is
enforced by code convention and review, not a database trigger — matching
the project's existing light-ops-overhead style (e.g. `toSafeUser` in
Phase 2 is the same kind of single-writer discipline).

### Concurrency / invariants
`applyEntry` takes a pessimistic row lock (`SELECT ... FOR UPDATE` via
`tx.$queryRaw`, inside the caller's Prisma interactive `$transaction`)
before reading/writing a wallet's balances, serializing concurrent
mutations against the *same* wallet while leaving different users'
wallets unaffected. Both resulting balances are checked non-negative
before any write; a violation throws and the whole transaction rolls
back. This was verified against real concurrent requests in e2e tests
(two withdrawal requests fired via `Promise.all`, together exceeding the
balance — exactly one succeeds), not just asserted.

Defense in depth: the migration also adds hand-written `CHECK` constraints
(`availableBalanceMinor >= 0`, `heldBalanceMinor >= 0`, and
`amountMinor > 0` on `Deposit`/`Withdrawal`) below the application-level
checks.

Financial relations (`Wallet`, `Deposit`, `Withdrawal` → `User`) use
`onDelete: Restrict` — a user with any financial history can never be
deleted. There is no user-deletion feature yet; this is a forward
guarantee.

### Idempotency
Two independent, schema-level mechanisms (no separate generic
"idempotency record" table — the specific unique constraints already are
the mechanism):
- **Client-request idempotency**: `@@unique([userId, idempotencyKey])` on
  `Deposit`/`Withdrawal`. A retried create with the same key returns the
  **original** record (Stripe-style), not an error.
- **Provider-event idempotency**: `@@unique([provider, providerEventId])`
  on `ProviderEvent`. A duplicate webhook delivery is a no-op by database
  constraint. `DepositsService` additionally no-ops if the target deposit
  is no longer `PENDING`, as a second layer.

### Withdrawal state machine
`PENDING_REVIEW → APPROVED → COMPLETED`, with `REJECTED` (from
`PENDING_REVIEW`) and `FAILED` (from `APPROVED`) releasing the held funds,
and user-initiated `CANCELLED` (only from `PENDING_REVIEW`). This is
deliberately collapsed from the spec's illustrative `REQUESTED → PENDING →
APPROVED → PROCESSING → COMPLETED` example: there is no asynchronous
payout worker yet (see ADR-013), so a separate `PROCESSING` state would
have no distinguishable behavior from `APPROVED`. `COMPLETED` is reached
by an admin manually confirming a payout was sent — the honest
reflection of not having live payout-provider access yet, not a
simulated automatic settlement.

### Admin adjustment
Exactly one administrative balance-editing path:
`POST /admin/wallets/:userId/adjustments` — `direction` (`CREDIT`/`DEBIT`),
amount, and a mandatory reason (≥10 characters), authenticated as the
admin who authorized it, applied through the exact same `applyEntry` as
every other mutation (so a `DEBIT` still cannot drive the balance
negative). There is no generic "set balance to X" endpoint.

### Future extensibility (documented, not implemented)
- **User-to-user transfers** (explicitly deferred): would add a new
  `LedgerEntryType` pair (e.g. `TRANSFER_OUT`/`TRANSFER_IN`) and a new
  `applyEntry` caller; the wallet/ledger model already supports two
  wallets being debited/credited in the same transaction without schema
  changes.
- **Betting settlement** (explicitly deferred): `PRIZE`/`PLATFORM_FEE`
  ledger types already exist for this; a future `SettlementService` would
  call `applyEntry` once per affected wallet within one transaction.

## Alternatives Considered
- **Optimistic concurrency (version column + retry)** instead of
  pessimistic row locking — rejected for this phase: financial correctness
  under contention is easier to reason about and test with a lock that
  simply serializes writers, and expected contention per wallet (a single
  user's own concurrent requests) is low enough that lock wait time is a
  non-issue.
- **A generic `IdempotencyRecord` table** separate from `Deposit`/
  `Withdrawal`'s own unique constraints — rejected as redundant; the
  specific constraints already express exactly the dedup scope needed.
- **Floating-point or fixed-decimal (`Decimal`) money columns** — rejected;
  integer minor units avoid an entire class of rounding-precision bugs
  and match how most payment processors represent money internally.

## Consequences
- Every future phase that touches money (betting, prize pools, platform
  fees, transfers) must go through `LedgerService.applyEntry` and the
  existing `Wallet`/`LedgerEntry` schema — not a new balance mechanism.
- The money-as-string wire format is now a permanent API contract;
  changing it would be a breaking change to mobile and admin clients.
