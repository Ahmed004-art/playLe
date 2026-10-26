# ADR-026: Social Foundation (blocking, pair lock, social throttling)

## Status
Accepted - Phase 12. Only the **blocking** part is implemented so far
(PR 1); friends, profiles and presence exposure are specified here so the
whole phase rests on one design, and are marked *planned*.

## Context
Phase 12 adds the social half of "social + gaming": public profiles, friend
requests, a friends list with presence, challenging friends, and a match
history screen. Blocking comes first because every later feature must respect
it, and because it is the part that touches an existing financial-adjacent
flow (challenge creation and acceptance, which can create a staked match).

Facts from the code that shape the design:

- `ChallengesService.accept` claims a challenge with
  `updateMany(where PENDING)` and then calls `MatchesService.createMatchGuarded`
  in one transaction. `createMatchGuarded` serialises per-user with
  `pg_advisory_xact_lock(hashtext(userId))` ([ADR-024](ADR-024-match-lifecycle-integrity.md)).
- There is no row to lock for "this pair's social state": a block, a
  challenge and (later) a friendship are separate rows, and the races that
  matter are about rows that do not exist yet.
- `@nestjs/throttler` applies **every** named throttler to **every** route
  unless it is skipped; `@Throttle({ matches: {} })` on a route is an empty
  override, not an opt-in.
- Presence (`PresenceService`, Redis, 30 s TTL) is documented as exposed only
  for a current match opponent ([ADR-005](ADR-005-redis.md) is the
  authority for its ephemeral nature).

## Decision

### Block model
`UserBlock(blockerId, blockedId, createdAt)`, primary key
`(blockerId, blockedId)`, index on `blockedId`, cascade-deleted with either
user, and a database `CHECK (blockerId <> blockedId)` (hand-written in the
migration, because Prisma cannot declare check constraints). One directed row
owned by the blocker.

### Semantics
- **Effect is symmetric, ownership is not.** While *either* player has a block
  against the other, neither can create a challenge to the other, and a
  pending challenge between them cannot be accepted.
- **A block never reveals itself.** The blocker is told plainly
  (`409 You have blocked this player`). The blocked player receives the same
  `404 Opponent not found` as for an account that does not exist. Accepting a
  blocked challenge returns the same `409 This challenge is no longer pending`
  as any other challenge that is gone. If both have blocked each other, the
  caller's own block takes precedence in the message.
- **Blocking cancels pending challenges** between the two players (either
  direction), in the same transaction as the block, and emits the existing
  `challenge:resolved` (`CANCELLED`) event to both players after commit.
- **Idempotent both ways.** Re-blocking returns the existing block; unblocking
  something not blocked succeeds (`204`).
- **Unblocking removes only the caller's own direction** and **restores
  nothing**: cancelled challenges stay cancelled.
- **Blocking never touches a running match.** A match already created stays as
  it is; blocks are about starting new interactions.
- **The list is the caller's own blocks only.** Nothing exposes who has blocked
  a player.
- Out of scope for blocking: random matchmaking is unchanged (a blocked pair
  can still be matched by the queue). Blocking is enforced in direct
  challenges only, per the Phase 12 scope.
- *Planned (friends PR):* blocking also deletes an existing friendship and
  cancels pending friend requests in either direction, in the same
  transaction; and the blocked/blocker's profile, lookup and presence are
  hidden from each other. *Planned (profiles PR):* `GET users/lookup` and the
  profile endpoint 404 for a player who has blocked the caller.

### Pair lock
`lockUserPair(tx, a, b)` takes `pg_advisory_xact_lock(1201, hashtext("low:high"))`
on the sorted pair. The two-int form is a separate key space from the
single-bigint per-user lock `createMatchGuarded` uses, so they cannot collide.
It is held to commit or rollback.

Rules:
1. **Acquire it first** in any transaction that needs it: before claiming a
   challenge or friend-request row, and before `createMatchGuarded`'s per-user
   locks. `block`/`unblock` lock the pair and then touch challenge rows;
   `accept` locks the pair and then claims the row and takes per-user locks.
   One consistent order is what rules out a deadlock between them.
2. Block, unblock and challenge-accept take it. Challenge *creation* does not
   (it is advisory, matching the existing early checks in `create`); the
   authoritative block check is the one inside `accept`.

### Races this closes
- **Accept vs block.** Serialised by the pair lock. Block first: the accept
  rechecks inside its locked transaction, sees the block, and cancels the
  challenge. Accept first: the match exists before the block and is left
  running; the block's cascade finds nothing pending.
- **Create vs block.** A challenge may be inserted concurrently with a block and
  survive as PENDING. It can never become a match: the recheck in `accept`
  refuses it and cancels it (committing that cancellation rather than throwing,
  which would roll it back).
- **Duplicate block.** `upsert` under the pair lock; the primary key is the
  backstop.

### Social throttler
A named `social` throttler (`SOCIAL_THROTTLE_LIMIT`, default 20, and
`SOCIAL_THROTTLE_TTL_MS`, default 60000), **opt-in**. Because the guard applies
every named throttler to every route, `social` carries a `skipIf` that skips
any route not marked `@SocialThrottle()`, so registering it changes the rate
limit of no existing endpoint. Block/unblock/list are marked; friend-request
routes will be.

### Planned (not implemented in PR 1)
- `FriendRequest` (status PENDING/ACCEPTED/DECLINED/CANCELLED) with a nullable
  `pendingPairKey` that is set only while PENDING and unique, giving "at most
  one open request per pair" without a raw-SQL partial index; `Friendship`
  stored once per pair as `(userLowId, userHighId)` with `low < high`.
  Crossed requests auto-accept. Limits: 200 friends, 50 outgoing pending
  requests.
- **Presence exposure.** Presence becomes visible to a player's accepted
  friends (never to a blocked pair), in addition to a current match opponent.
  This changes the privacy rule documented in `PresenceService`, which will be
  updated in the friends PR.
- Public profile: username, display name, avatar, games played, wins, losses,
  draws (from COMPLETED matches only). Never email, phone, date of birth,
  role, status, wallet or stakes.

## Consequences
- One additive migration (`user_blocks`, and an index on `match_players(userId)`
  that the later history/profile queries need). No existing column changes, no
  backfill.
- `ChallengesService` gains a dependency on `BlocksService`; the accept
  transaction gains one advisory lock and one indexed read. Throughput impact is
  negligible for a per-pair lock.
- The `blocks` module is the single place that answers "are these two players
  blocked", so friends and profiles reuse `BlocksService.relationBetween`
  instead of re-deriving it.

## Not changed
Wallet, ledger, payments, settlement, eligibility, responsible gaming, real-money
flags, matchmaking behavior, and every existing route's rate limit.
