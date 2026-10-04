# ADR-009: Financial Model — Immutable, Auditable Ledger

## Status
Accepted — Phase 1 (documentation only; not implemented)

## Context
PlayLe moves real money: deposits, match stakes, prize-pool payouts,
platform fees, withdrawals, refunds, and administrative adjustments. A
naive implementation (a single mutable `balance` column updated in place)
cannot answer basic audit questions and is unacceptable for a real-money
platform.

## Decision
The future financial system will be built as a **wallet + immutable ledger**
model, never a bare mutable balance:

- Every financial event (deposit, stake, payout, fee, withdrawal, refund,
  admin adjustment) is recorded as an **immutable ledger entry** with a
  unique transaction ID, the previous balance, the resulting balance, the
  causing match/user, and a timestamp.
- A user's current balance is a derived/cached projection of their ledger
  entries, not the source of truth.
- All financial writes happen inside **atomic database transactions**.
- All financial operations are **idempotent** (safe to retry without
  double-applying).
- Administrative balance adjustments require a recorded authorizing admin
  identity and reason.

This lets the system answer, for any transaction: where the money came
from, where it went, which match caused it, who initiated it, the
before/after state, whether it was reversed, and who authorized an
administrative adjustment (see Section 14 of the project specification).

## Alternatives Considered
- **Mutable balance column, updated via `UPDATE ... SET balance = balance
  + x`** — simplest to implement, but provides no audit trail, no way to
  reconstruct history, and no protection against double-application on
  retry. Explicitly rejected by project instructions and by ordinary
  fintech practice.
- **Event sourcing for the entire platform** — the ledger itself is
  effectively an append-only event log for financial events, which this
  ADR adopts. Applying full event sourcing to *every* domain (users,
  social, games) is rejected as over-engineering for current needs
  (Section 31).

## Consequences
- The database schema for Wallet/Ledger (designed in the dedicated
  database phase) will include append-only transaction tables, not just a
  balance field.
- All financial mutation code paths must go through the ledger-writing
  service; no domain is permitted to mutate a balance directly.
- This is documentation only for Phase 1 — no wallet, ledger, staking, or
  payout logic is implemented yet (see Section 30 of the project spec).
