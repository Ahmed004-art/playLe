# ADR-023: Server-Enforced Rolling-Window Spending & Loss Limits

## Status
Accepted — Phase 8

## Context
ADR-021 (Phase 6) deliberately shipped `DEPOSIT_LIMIT`/`STAKE_LIMIT` as
per-action ceilings only, and recorded `LOSS_LIMIT` without enforcing it
at all, documenting both as an explicit simplification — "a correct
rolling-window sum... is a materially larger feature" — tracked as
outstanding-work item 7. Phase 8's spec requires turning that into real,
server-enforced rolling-window spending and loss-limit enforcement,
authoritative in the backend regardless of what any client (mobile,
admin, or a direct API call) sends.

The spec leaves several semantics genuinely undefined — window length,
what counts as spending vs. a loss, how refunds/draws/retries interact
with the totals, where the check must live to be concurrency-safe. This
ADR picks conservative defaults for each and makes them testable, per
the spec's instruction for exactly this situation.

## Decision

### The rolling window is a fixed platform parameter, not user-configurable
`RESPONSIBLE_GAMING_WINDOW_HOURS` (`src/config/`, default `24`) sets the
window length for every user. It is **not** stored per-restriction and
has no user-facing control to change it. Only the limit *amount* remains
user-configurable, exactly as before. If the window length were
per-user, a user could shrink their own window to make a large limit
amount loosely enforced in practice — a direct version of the "repeatedly
changing settings to evade a limit" bypass the spec warns against. A
fixed platform-wide window closes that path by construction.

### What counts as spending vs. a loss, and why each source is authoritative
- **`STAKE_LIMIT`**: sum of `LedgerEntry` rows of type `STAKE_HOLD` for
  the user within the window. This is the same row `LedgerService`
  writes the instant a stake is actually held — not a client-reported
  amount, not something computed from match state.
- **`DEPOSIT_LIMIT`**: sum of **completed** `DEPOSIT` ledger entries
  within the window. A pending/failed deposit was never actually
  spending.
- **`LOSS_LIMIT`**: sum of `SettlementEntry` rows with `role: 'LOSER'`
  within the window. `SettlementEntry.role` is written once, by
  `SettlementService.settle`, strictly from the game module's
  server-computed result — never from anything a client submits. Using
  `role` as the sole source means a win, a draw (`DRAW_PARTICIPANT`), and
  a refund (`REFUND_RECIPIENT`) are *excluded by construction*, not by an
  extra filter that could be gotten wrong — there is no separate "was
  this a loss" computation to drift out of sync with settlement itself.
- A cancelled/abandoned match that never reaches `SettlementService.settle`
  produces no `SettlementEntry` at all, so it never contributes to the
  loss sum; its held stake is released back to available balance by the
  existing cancellation path, so it never contributes to the stake sum
  either once released.

### Exactly-once accounting under retry/recovery
`Settlement.matchStakeId` is `@unique` (pre-existing, Phase 5). A retried
or recovered settlement attempt for the same match either fails that
constraint or is a no-op short-circuit before ever writing a second
`SettlementEntry` row — so the rolling-loss sum is immune to
double-counting by construction, not by Phase 8 adding new dedup logic.
This is verified directly: a dedicated e2e test calls
`SettlementService.settle(matchId)` twice and asserts the loser's
`SettlementEntry` count stays at exactly 1.

### Check semantics: prospective for spending, retrospective for loss
- `STAKE_LIMIT` / `DEPOSIT_LIMIT`: `existingInWindow + newAmount > limit`
  is rejected — a user may spend up to and including exactly the limit.
  This is prospective because the new action's amount is known before it
  happens.
- `LOSS_LIMIT`: `existingInWindow >= limit` is rejected — purely
  retrospective, evaluated against *already-settled* losses only. A
  not-yet-played stake's eventual outcome is unknown, so there is nothing
  to project; blocking a new stake once *already-realized* losses are at
  or over the limit is the only sound check.

### Enforcement point: inside the existing stake-confirmation transaction, after the existing wallet lock
`EligibilityService.assertCanStake` is called inside
`MatchStakesService.confirmStake`'s `$transaction`, immediately after
`LedgerService.lockWallet(tx, walletId)` — which already takes a
`SELECT ... FOR UPDATE` row lock on that user's wallet for every
financial mutation (pre-existing, Phase 3). Two concurrent
`confirmStake` calls for the same user are therefore already serialized
by Postgres before either one's eligibility check runs: the second
call's rolling-sum query only executes after the first call's stake has
either committed or rolled back, so it is impossible for two concurrent
stakes to each see a stale "under limit" total and together exceed it.
No new lock, semaphore, or Redis coordination was introduced — the
existing financial-concurrency primitive already gives the rolling
checks the exact guarantee they need, applied at the one place in the
codebase where a stake becomes real.

The same call also runs earlier, advisory-only, inside
`validateStakeRequest` (challenge/match creation time) purely to give an
immediate rejection in the common case — but that call is *not* the
authoritative gate; only the post-lock call inside `confirmStake` is.

### Closing the opponent-side eligibility gap
Auditing every path into a staked match found that
`ChallengesService.accept()` checked only the challenger's eligibility
(at `create()` time) and never the *opponent's* — so a self-excluded or
over-limit opponent could accept an incoming staked challenge. Fixed by
calling `EligibilityService.assertCanStake` for the opponent inside
`accept()` before the match is created. `MatchmakingService` already
re-validates both sides at `confirmStake` regardless of entry path, so
this closes the one path that skipped the authoritative check entirely
before this fix.

### Deposit-limit rolling check: a documented, accepted concurrency limitation
Unlike a stake, deposit completion is driven by an asynchronous provider
webhook — there is no request in flight at the moment a deposit
*completes* against which a wallet lock could be held. The rolling
deposit check therefore cannot offer the same "two concurrent attempts
can't together exceed the limit" guarantee the stake/loss checks have;
it correctly blocks *initiating* a new deposit once the rolling sum of
already-**completed** deposits would exceed the limit, which is the
practically achievable guarantee given the provider's async model. This
is accepted as a documented limitation, not silently claimed as fully
concurrency-safe.

### Notification and auditability
`EligibilityService.notifyLimitReached` enqueues a
`RESPONSIBLE_GAMING_LIMIT_REACHED` notification (new enum value) before
every rolling-limit rejection, via the existing `NotificationOutboxService`
— the same outbox/dispatch path as every other notification, giving the
same durable audit trail of what was evaluated and when. The rejection
itself (`ForbiddenException`) carries a reason string distinguishing
which limit (stake/loss/deposit) was hit.

### Read visibility: `getRollingUsage`
`EligibilityService.getRollingUsage(userId)` computes all three rolling
sums read-only, exposed via `GET /auth/responsible-gaming/usage` (self)
and `GET /admin/responsible-gaming/:userId/usage` (admin, read-only, no
corresponding write/override endpoint) — the same figures the
enforcement path actually compares against, not a separately-maintained
display value that could drift from what's enforced.

## Alternatives Considered
- **Per-user configurable window length** — rejected; see "fixed platform
  parameter" above. A user-set window is a direct evasion vector.
- **Projecting a loss limit prospectively against an unsettled stake's
  worst case** — rejected; the outcome of a not-yet-played match is
  unknown by definition (ADR-008, server-authoritative outcomes), so
  there is nothing sound to project against.
- **A new dedicated lock/coordination mechanism for the rolling checks**
  — rejected; the existing wallet row lock already serializes every
  financial mutation for a user, so introducing a second mechanism would
  duplicate an existing guarantee rather than add one.
- **Treating any `SettlementEntry` touching the user as a loss (instead
  of filtering by `role`)** — rejected; would incorrectly count wins,
  draws, and refunds as losses, exactly the miscounting the Phase 8 spec
  calls out as unacceptable.

## Consequences
- Changing the rolling window's length is an owner/deploy-time config
  change (`RESPONSIBLE_GAMING_WINDOW_HOURS`), not a user action — by
  design.
- The deposit-limit rolling check's concurrency limitation (above) is
  recorded here and in `docs/development/OUTSTANDING_WORK.md` rather
  than left implicit.
- A future richer loss-reason model (e.g. distinguishing a resignation
  from a normal loss) is additive to `SettlementEntry.role` and does not
  require restructuring this enforcement point.
