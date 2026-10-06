# ADR-017: Deterministic Settlement — Fee Math, Exactly-Once, Recovery, Reconciliation

## Status
Accepted — Phase 5 (implemented)

## Context
Once a match reaches a terminal state, its stake must resolve to exactly
one financial outcome — a winner payout, a draw refund, or a
cancellation refund — computed the same way every time, safe to retry
after a crash, and auditable after the fact. This ADR covers
`SettlementService` (`apps/api/src/settlement/`), the settlement math it
calls, and the recovery/reconciliation built on top of it.

## Decisions

### Pure math, separate from orchestration
Every money-moving decision lives in `settlement-math.ts` — plain
functions (`computeWinSettlement`, `computeRefundSettlement`,
`isBalanced`), no Prisma, no NestJS, no I/O. This is deliberate: the
local development environment used for this phase has no writable
Postgres role available (see "Known Limitations" in
`docs/architecture/SECURITY.md`), so the one thing that absolutely had
to be verified without a database is the arithmetic itself —
`settlement-math.spec.ts` exhaustively covers boundary values (zero
pool, zero/100% fee, a 1-minor-unit stake, a billion-minor-unit stake)
independently of any integration test.

### Rounding policy
`fee = floor(pool * platformFeePercent / 100)`, computed entirely in
`BigInt` (whose division already truncates toward zero — floor, for the
non-negative values here). `payout = pool - fee`. Matches the worked
example in CLAUDE.md exactly (Le100 each, 10% → Le20 fee, Le180 payout).

### One entry point, one outcome, four causes
`SettlementService.settle(matchId)` is the **only** way a `MatchStake`
ever resolves, called from every terminal path: a normal win/draw
(`MatchesService.submitCommand`'s completion branch), a disconnect
forfeit (`MatchTimeoutService.abandonDisconnectedMatches` — reuses the
exact same win computation, since a forfeit's financial shape is
identical to a win), a stake-commit timeout or double-disconnect
(`MatchTimeoutService.expireWaitingMatches`, outcome `CANCELLED`), and
the recovery sweep (below). `settle` derives the outcome from the
**match's own already-decided state** (`status`/`winnerUserId`/
`resultIsDraw`) — it is never given a winner by a caller, closing off
any path to a forged settlement.

### Exactly-once is a database constraint, not application logic
`Settlement.matchStakeId` is `@unique`. `settle()` always attempts to
`create` the `Settlement` row *first*, inside its transaction, before
moving any money; a second concurrent or retried call hits `P2002`,
which is caught and treated as "someone else already settled this" —
returning the existing row rather than erroring or re-paying. This is
the same idempotency pattern already used for `MatchCommand.id` and
`Deposit`/`Withdrawal.idempotencyKey` (Phase 3/4) — not a new mechanism.

### Multi-wallet lock ordering
Settlement is the first place in the codebase that locks more than one
wallet in a single transaction (winner, loser(s), platform). Every
movement locks its wallet via the existing `LedgerService.lockWallet`
(which must happen before any new row referencing that wallet — see its
own doc comment for the deadlock this avoids), and movements are sorted
by `userId` before locking, so two settlements that happen to share a
player (e.g. the same person in two different matches finishing at once)
can never acquire each other's locks in reverse order.

### Crash recovery
`settle()` optimistically flips `MatchStake.ACTIVE → SETTLING` just
before its transaction (best-effort, never checked) — purely a signal
for recovery, not the correctness mechanism. `MatchTimeoutService`'s
existing periodic sweep gained `recoverStuckSettlements()`: it finds any
match already in a terminal status whose stake is not yet `SETTLED`/
`REFUNDED` (stuck in `ACTIVE`, `SETTLING`, or `FAILED` — a crash,
timeout, or transient DB error between the match completing and
settlement finishing) and calls `settle()` again. Idempotent by
construction, so retrying an already-settled stake is always a safe
no-op.

### Reconciliation is read-only, on demand
`ReconciliationService.runOnce()` (exposed at `GET
/admin/reconciliation/run`) checks for orphaned holds, missing
settlements, duplicate settlements (structurally prevented by the
`@unique` constraint — checked anyway, as documentation and defense in
depth), unbalanced settlements (re-deriving the conservation invariant
from persisted `SettlementEntry` rows, not just trusting the original
in-memory computation), and wallet/ledger mismatches (recomputing a
wallet's balance from its own ledger history from zero). It never
writes anything — anomalies are reported for a human to act on, per
the Phase 5 spec's explicit "must not silently modify financial
records."

## Alternatives Considered
- **A saga/outbox pattern for multi-step settlement** — rejected as
  over-engineering for this phase: everything settlement touches is in
  the same Postgres database, so a single ACID transaction already gives
  atomicity; an outbox exists to coordinate across separate systems,
  which doesn't apply here.
- **Scheduling reconciliation to run automatically** — rejected: the
  spec explicitly wants anomalies flagged for review, not auto-corrected,
  and an admin-triggered report is simpler than a new background job for
  a phase with no real-money production traffic yet.
- **Giving `Settlement` its own `winnerUserId` column** — rejected as
  redundant with `Match.winnerUserId`, which already is the single
  authoritative source; `SettlementEntry.role` captures the same
  information per-party for audit purposes without duplicating it.

## Consequences
- A future 3-/4-player or N-player settlement needs no change to
  `SettlementService` itself — `computeWinSettlement`/
  `computeRefundSettlement` already operate over an arbitrary player
  list.
- Any future provider-driven payout phase (e.g. paying real winnings out
  to mobile money) still ends at the same `LedgerService.applyEntry` —
  this phase's settlement is the trigger, not a separate money-movement
  mechanism to reconcile against.
