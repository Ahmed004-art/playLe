# ADR-018: Financial State Machines — Transitions, Disputes, Compensating Transactions

## Status
Accepted — Phase 5 (implemented)

## Context
ADR-016 introduced two coordinated state machines (`Match`'s own
lifecycle and `MatchStake`'s financial lifecycle); ADR-017 covered how
settlement resolves the financial one. This ADR documents the exact
transitions, where `HELD` went, and how disputes/corrections fit in
without ever mutating history.

## Decisions

### `MatchStakeStatus` transitions

```
PENDING ──(every player's stake confirmed)──> ACTIVE ──(match reaches a terminal
  │                                                       status)──> SETTLING ──> SETTLED
  │
  ├──(stake-commit timeout, or the match is otherwise
  │   cancelled before every player held)──> CANCELLED ──(settle() refunds
  │                                                         whoever held)──> REFUNDED
  │
  └──(a settlement attempt throws)──> FAILED  (recovery sweep retries settle(); on
                                                 success the row still ends at
                                                 SETTLED/REFUNDED above)
```

`HELD` is declared in the enum (matching the Phase 5 spec's explicit
state list) but is **not a distinct reachable state in this phase**:
the moment every player's `MatchStakePlayer.heldAt` is set,
`MatchStakesService.confirmStake` transitions the stake straight
`PENDING → ACTIVE` in the same step it flips `Match.WAITING → ACTIVE` —
there is no observable gap between "fully held" and "active," exactly
mirroring Phase 4's own precedent of `Match.READY` collapsing
immediately into `ACTIVE` for a 2-player game with no real waiting room.
Both reserved values exist for a future game where staggered
confirmation (e.g. a 4-player stake with players confirming minutes
apart) makes the intermediate state real and worth observing.

`DISPUTED` is also reserved but unused: opening a dispute
(`DisputesService.create`) deliberately does **not** touch
`MatchStake.status`. A dispute is tracked entirely on its own `Dispute`
row; the stake's settlement already happened and is immutable regardless
of whether someone disputes it later (see "Disputes never move money"
below). Coupling the two would let dispute state leak into — and
potentially block — unrelated reads of the settlement's own status.

### How the two state machines actually coordinate
Exactly two touch points, both already covered by ADR-016/017:
1. `MatchesService.createMatch` with a stake creates `Match` as
   `WAITING` (not `ACTIVE`) instead of its Phase-4 free-play default.
2. `MatchStakesService.confirmStake`, once every player has held, flips
   `MatchStake → ACTIVE` and `Match: WAITING → ACTIVE` together. Every
   other coordination point (a match finishing triggers settlement) is
   one-directional: `Match`'s lifecycle never reads `MatchStake`'s
   status to decide anything about gameplay once both are `ACTIVE`.

### Disputes never move money
`DisputeStatus`: `OPEN → UNDER_REVIEW → UPHELD | REFUNDED | RESOLVED`.
Creating or resolving a dispute is a pure status + audit-text write —
`DisputesService` has no code path that calls `LedgerService` or
touches a `Wallet`. If a dispute is upheld and a real correction is
needed, an admin performs it as its own, separate, already-audited
action: `POST /admin/wallets/:userId/adjustments` (Phase 3's existing
narrow adjustment path — reason required, admin-attributed, still
cannot drive a balance negative). This satisfies the spec's
"compensating transaction, never mutate history" requirement for free:
Phase 3's adjustment mechanism already is a compensating transaction
(a new `ADJUSTMENT` ledger row), and Phase 5 adds no second one.

### Why not auto-trigger a refund from "UPHELD"
Tempting, but rejected: it would mean a dispute resolution's `status`
field secretly carries financial authority, which contradicts "admin
safety" (no casual money-moving shortcut) more than it saves a second
API call. Keeping the two actions separate and both independently
audited is a deliberate, small amount of friction in exchange for an
admin never being able to accidentally move money by resolving a
dispute.

## Alternatives Considered
- **Letting `confirmStake` leave the stake in a real `HELD` state before
  a separate "activate" step** — rejected for this phase: with only
  ever two players and both already known at match creation, there is
  no meaningful work to do between "everyone held" and "game can start";
  adding a step would be speculative generality for a transition that
  doesn't yet exist in practice.
- **A single `resolve` dispute endpoint that accepts an optional refund
  amount** — rejected per "Why not auto-trigger a refund" above.

## Consequences
- A future N-player game with asynchronous stake confirmation can
  introduce real `HELD` semantics (e.g. a lobby countdown) without a
  schema change — the enum value already exists and `confirmStake`'s
  "collapse into ACTIVE" is an implementation choice, not a constraint
  baked into the data model.
- Reconciliation's "orphaned hold" check already treats `HELD` as a
  stuck-state signal (see `ReconciliationService`), so it needs no
  change either when that day comes.
