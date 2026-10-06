# ADR-016: Match Financial Architecture — Stakes, Holds, Prize Pools, Platform Account

## Status
Accepted — Phase 5 (implemented)

## Context
Phase 4 built the generic, server-authoritative match/matchmaking/
challenge platform with no money involved. Phase 5 connects it to
Phase 3's wallet/ledger system: players stake equal amounts, the server
holds the money, and a completed match's authoritative result drives a
deterministic settlement. The financial system (Phase 3) and the game
system (Phase 4) must stay cleanly separated — this ADR is about the
layer that connects them, not a redesign of either.

## Decisions

### New models: `MatchStake` + `MatchStakePlayer`
A `MatchStake` is 1:1 with a `Match` (`matchId` unique, `onDelete:
Restrict` — financial history, same protection as `Wallet`/`Deposit`/
`Withdrawal`). `stakeAmountMinor` is a single value on the stake, not a
per-player column — **equal-stake is enforced by construction**, not by
an extra validation rule. `MatchStakePlayer` mirrors `Match`/
`MatchPlayer`'s existing shape and tracks each player's own `heldAt`.

### Two coordinated state machines, not one
`Match`'s own lifecycle (`WAITING → READY → ACTIVE → COMPLETED/
CANCELLED/ABANDONED`, from Phase 4) is untouched. A new, separate
`MatchStakeStatus` (`PENDING → ACTIVE → SETTLING → SETTLED`, with
`REFUNDED`/`CANCELLED`/`DISPUTED`/`FAILED` branches; `HELD` is reserved —
see ADR-018) governs the money. They coordinate at exactly two points:
a financially-backed match starts `WAITING` (not `ACTIVE`) and only
becomes `ACTIVE` once every player's stake is held; and a match reaching
a terminal status triggers settlement. Free play is simply "no
`MatchStake` row exists" — every stake-aware code path checks for the
row's existence and no-ops when it's absent, so Phase 4's free-play
flows are unmodified.

### Stake request flow
A stake is proposed at matchmaking-join or challenge-create time
(`StakeRequestDto { amountMinor, currency }`, optional — omitting it is
ordinary free play) and validated immediately
(`MatchStakesService.validateStakeRequest`: real-money gate, minimum
age, amount bounds, advisory balance check). **No money moves yet** —
matchmaking only pairs players who requested the identical amount+
currency (queue key includes both, so pairing itself guarantees equal
stakes); a challenge stores the amount immutably on the `Challenge` row.
The match is created `WAITING`. Each player then calls `POST
/matches/:id/stake/confirm` to actually commit — this is the only place
money is held, is idempotent, and is concurrency-safe via the same
conditional-`updateMany` pattern `ChallengesService` already uses.

### Real-money eligibility is not identity eligibility
`stakes.realMoneyMinimumAge`/`REAL_MONEY_MINIMUM_AGE` is a config value
entirely separate from `auth.minAgeYears` (Phase 2's general account age
gate). An account old enough to register is not automatically old enough
to stake real money — the two are checked independently, at different
times, for different purposes. `stakes.realMoneyGamingEnabled` is a
master off switch, default `false`: the system never enters real-money
mode because a variable is merely unset.

### The platform/system account
PlayLe's fee needs a real, auditable destination — never a bare
arithmetic "don't pay out the full pool" shortcut. Implemented as a real
`User` row (new `UserRole.SYSTEM`, `status: DISABLED`, seeded once by
migration with its own `Wallet`) rather than a schema change making
`Wallet.userId`/`LedgerEntry.userId` nullable. This reuses every existing
`LedgerService`/`WalletService` code path completely unmodified — the
system account's wallet is locked and credited exactly like a player's.
`status: DISABLED` already blocks it from login (`JwtAuthGuard`) and
from challenge-opponent selection (`ChallengesService` requires `status:
'ACTIVE'`) with zero additional checks anywhere.

### New `LedgerEntryType` values
`STAKE_HOLD` (available → held, at confirm time), `STAKE_REFUND` (held →
available, no fee — a draw or a cancellation), `STAKE_LOSS` (a losing
player's held stake is simply consumed — held decreases, nothing is
credited back). `PRIZE` and `PLATFORM_FEE`, reserved since Phase 3, are
produced for the first time here. `LedgerEntry.relatedMatchStakeId` was
added for traceability — see ADR-017 for how settlement uses it.

## Alternatives Considered
- **Nullable `Wallet.userId`/`LedgerEntry.userId` for a "real" system
  account with no `User` row** — rejected: it would require touching
  every existing query/constraint that currently assumes a non-null
  owner, for no benefit over a disabled `User` row that already can't
  log in or be selected as an opponent.
- **A single combined state machine on `Match` itself** (adding
  stake-related statuses directly to `MatchStatus`) — rejected: it would
  conflate "is the game being played" with "has the money moved," make
  free play and staked play share a status enum that only half applies
  to each, and contradict Phase 4's own `ADR-015` module boundary
  (`Matches` stays game-generic, financial concerns stay in their own
  layer).
- **Letting matchmaking match players at different stakes and settle
  the difference** — rejected: the product rule is equal stakes (see
  CLAUDE.md, "Financial Rule"); segmenting the queue by stake is simpler
  and makes the invariant impossible to violate rather than merely
  validated.

## Consequences
- Every future game plugs into this same pipeline without changes: it
  only needs to produce an authoritative `Match.winnerUserId`/
  `resultIsDraw`, exactly like Tic-Tac-Toe already does.
- A 3- or 4-player game (CLAUDE.md's long-term scope) needs no schema
  change here — `MatchStakePlayer`/`SettlementEntry` are already
  per-player rows, not fixed two-column fields.
