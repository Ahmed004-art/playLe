# ADR-021: Centralized Real-Money Eligibility & Responsible-Gaming Foundation

## Status
Accepted — Phase 6

## Context
Phase 5 introduced `REAL_MONEY_GAMING_ENABLED` and
`REAL_MONEY_MINIMUM_AGE` (ADR-016), checked inline, twice, inside
`MatchStakesService` (`validateStakeRequest` and `confirmStake`). Phase 6's
spec required (a) centralizing this into one policy service rather than
leaving it scattered, and (b) adding a responsible-gaming foundation
(limits, cooling-off, self-exclusion) that nothing — including an
ordinary admin action — can silently bypass or lift.

The spec is explicit that the existing general account-creation age gate
(`AUTH_MIN_AGE_YEARS`, default 16) is **not** proof that a 16-year-old
may lawfully participate in real-money gaming in any given jurisdiction,
and that this codebase must not invent a legal eligibility threshold or
imply regulatory approval it has no basis to claim.

## Decision

### One service, two call sites collapsed into it
`EligibilityService` (`src/eligibility/`) is now the only place
real-money eligibility is checked. The two inline blocks in
`MatchStakesService` were deleted and replaced with calls to
`assertCanStake`; `DepositsService.create` gained a corresponding
`assertCanDeposit` call that did not exist before Phase 6.

### Two independent activation flags
`REAL_MONEY_GAMING_ENABLED` (Phase 5) and a new
`ELIGIBILITY_POLICY_CONFIGURED` must **both** be true before any
real-money action proceeds. These are deliberately independent rather
than one flag implying the other: `ELIGIBILITY_POLICY_CONFIGURED`
exists purely so the owner records that an actual, legally-reviewed
eligibility policy exists — flipping `REAL_MONEY_GAMING_ENABLED` alone
(e.g. by accident, or because a deploy script sets it as part of a
broader "turn features on" step) can never silently start real-money
gameplay with no configured legal policy behind it. `REAL_MONEY_MINIMUM_AGE`
(default 18) is documented, at every place it appears (config, `.env.example`,
this ADR), as a conservative placeholder the owner must confirm against
real legal advice — never as a value this codebase determined to be
correct.

### Self-exclusion: permanent, with no lift path anywhere
`ResponsibleGamingRestriction` rows are never destructively edited — a
change is always a new row, so the full history is reconstructable.
`SELF_EXCLUSION` is the one restriction type with **no lift method in
this codebase** — not in `ResponsibleGamingService`, not on any admin
controller, not reachable by any role. Absent a defined,
legally-authorized compliance-officer process (which does not exist in
this codebase and cannot be invented by an automated implementation),
the only safe default is that self-exclusion cannot be silently (or even
deliberately, via an ordinary admin action) turned back off. Admin
visibility (`GET /admin/responsible-gaming`) is read-only.

### What self-exclusion/cooling-off block — and what they deliberately don't
Both block deposits and real-money stakes. Neither blocks withdrawals:
`EligibilityService.assertCanWithdraw` is an explicit no-op with a doc
comment explaining why — letting an at-risk user get their own money
*out* of the platform is the responsible-gaming-correct behavior, not a
loophole to close. This is the standard pattern in real
responsible-gambling systems, not a PlayLe-specific judgment call.

### Amount limits are per-action ceilings, not rolling-period sums
`DEPOSIT_LIMIT`/`STAKE_LIMIT` are enforced by comparing one action's
amount against the configured `limitMinor`. This is a deliberate,
documented simplification — not a claim of complete spend-tracking —
chosen because a correct rolling-window sum (daily/weekly totals across
an arbitrary number of prior transactions) is a materially larger
feature that the Phase 6 spec's scope boundary ("do not build future
phases prematurely") does not ask for yet. `LOSS_LIMIT` is recorded and
visible via the status endpoint but not yet enforced at settlement — the
natural enforcement point (blocking a stake *before* it forms, based on
cumulative recent losses) is future work, not something silently claimed
as done.

## Alternatives Considered
- **Treating `AUTH_MIN_AGE_YEARS` as sufficient for real-money
  eligibility** — explicitly rejected by the spec and this ADR; kept as
  two separate, separately-configured values with separate documentation
  explaining why.
- **A single `REAL_MONEY_GAMING_ENABLED` flag with no second gate** —
  rejected; see "Two independent activation flags" above.
- **Allowing an admin role to lift a self-exclusion with a reason/audit
  trail (mirroring the existing admin-correction pattern used
  elsewhere)** — considered and rejected for this phase: every other
  admin override in this codebase (ledger adjustments, dispute
  resolution) corrects a *factual* error or exercises a *financial*
  judgment call within a defined process. Lifting a self-exclusion is a
  different kind of decision — it directly overrides a vulnerable user's
  own protective choice — and shipping that capability without a defined
  legal/compliance process behind it would be worse than not having the
  feature at all. Revisit only alongside a real compliance-officer role.
- **Blocking withdrawals for a self-excluded user "for consistency"** —
  rejected; see "What self-exclusion/cooling-off block" above.

## Consequences
- `REAL_MONEY_GAMING_ENABLED=true` alone (e.g. the existing Phase 5 CI
  configuration) is no longer sufficient to exercise the real-money
  engine — CI and any other environment that needs it must now also set
  `ELIGIBILITY_POLICY_CONFIGURED=true`, with a comment explaining this is
  a test-only exercise of the engine, not a claim that a real policy
  exists.
- A future real loss-limit enforcement, a rolling-window spend-tracking
  system, or a defined compliance-officer self-exclusion-lift process are
  all additive — none require restructuring `EligibilityService`'s
  existing call sites.
