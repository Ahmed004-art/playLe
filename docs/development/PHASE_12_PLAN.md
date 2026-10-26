# Phase 12 - Social Foundation: plan and status

Design: [ADR-026](../decisions/ADR-026-social-foundation.md). Scope was agreed
before implementation; this file tracks it PR by PR. Anything not listed under
"Scope" is out of scope - see "Do not build".

## Scope
- Public player profiles: display name, games played, wins, losses (draws).
- Friend requests: send, accept, decline, cancel, remove.
- Block / unblock, enforced in challenge creation and acceptance.
- Friends list with the existing online-presence data.
- Challenge friends through the existing challenge flow (free play only).
- Flutter match-history screen using the existing `GET /matches`.

## Decisions taken
1. Opponent names in history: a small batch lookup, `GET /users/summaries?ids=`
   (max 50; id, username, display name only; hides players who blocked the
   caller). The `GET /matches` response is unchanged.
2. Crossed friend requests auto-accept.
3. A profile is visible to any signed-in player who has the id.
4. Friend challenges are free play only in this phase.
5. A disconnect-forfeit's end state (COMPLETED vs ABANDONED) is verified when
   profile stats are implemented; stats count COMPLETED matches only.

## PR sequence and status

| # | PR | Status |
|---|---|---|
| 1 | Blocking foundation: `user_blocks` migration, `match_players(userId)` index, block/unblock/list API, block checks in challenge create and accept, pair lock, opt-in `social` throttler, ADR-026 | Implemented locally, **not pushed**; database-backed tests unverified until CI |
| 2 | Profiles and stats; `users/summaries`; block-aware `users/lookup` | Not started |
| 3 | Friends: `FriendRequest`/`Friendship`, request lifecycle, friends list with presence, block cascade to friends, realtime events | Not started |
| 4 | Flutter part 1: social models/controller, match history, profile screen, navigation | Not started |
| 5 | Flutter part 2: friends/requests/blocked screens, challenge from friend | Not started |

## PR 1 notes
- **Block cascade to friendships and friend requests** is part of ADR-026 but
  cannot exist before those models do; it lands in PR 3, in the same
  transaction as the block, behind the same pair lock.
- **`users/lookup` is not yet block-aware.** A blocked player can still resolve
  the blocker's id by exact username; they then get the indistinguishable `404`
  on challenge. Closed in PR 2.
- Random matchmaking is unchanged and may still pair a blocked pair.
- The `social` throttler is opt-in (`@SocialThrottle()`); registering it did not
  change any existing route's limit.

## Verification standard
Each PR: API unit tests, typecheck, lint, format; Flutter analyze/test for
mobile PRs. Database-backed e2e suites run only in CI (no local database);
they are reported as unverified until CI has run them. Nothing here is
device-verified (OUTSTANDING_WORK items 22 and 25 still apply).

## Do not build
Wallet, ledger, payment, settlement, real-money or responsible-gaming changes;
chat, feed, groups, followers, a user directory or search; a new matchmaking
engine (including block-aware matchmaking); deployment work.
