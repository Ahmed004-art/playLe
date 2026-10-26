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
  transaction, and presence is hidden between a blocked pair.

### Discoverability (PR 2)
One policy, in `blocks/block-visibility.ts`, used by profile, username lookup
and summaries so they cannot drift apart:

| Surface | Hidden from the viewer when | Hidden player looks like |
|---|---|---|
| `GET users/lookup`, `GET users/:id/profile` | the other player has **blocked the viewer** | an unknown username / unknown id: same status and body |
| `GET users/summaries` | a block exists in **either direction** | simply absent from `items`: no error, no marker |

- The **blocker can still resolve and open the player they blocked**, so they
  can see who it is and unblock them; the blocked player cannot do the reverse.
- Summaries are stricter because they label lists (match history, friends): a
  list must never name a player who has a block against the viewer or whom the
  viewer has a block against.
- A viewer always sees themselves. A player who is not `ACTIVE` is hidden
  everywhere, as lookup already did.
- Summaries answer for up to 50 players in **two queries** (users, then every
  block between them and the viewer via `BlocksService.relationsBetween`), never
  one per player.
- Malformed ids are `400` (profile path, summaries); a well-formed id that does
  not exist or is hidden is `404` (profile) or absent (summaries). Absent or
  empty `ids` is the empty list.

### Match statistics (PR 2)
Computed on read from stored match results; nothing is written and no
financial table is read. One aggregate query over `matches`, filtered through
`match_players` (indexed on `userId`). A match counts for a player only if they
are one of its players, its status is `COMPLETED`, and its stored result is
consistent:

- **win**: not a draw, and the winner is the player;
- **loss**: not a draw, the winner is someone else, and that winner is also one
  of the match's players;
- **draw**: `resultIsDraw` is true and there is no winner.

Every other `COMPLETED` row (no winner and not a draw; a draw that also names
a winner; a winner who is not a player) is excluded rather than guessed at, so
`gamesPlayed = wins + losses + draws` always holds. `ABANDONED`, `CANCELLED`,
`EXPIRED`, `WAITING`, `READY` and `ACTIVE` matches never count.

**Limitation (deliberate):** a disconnect forfeit is stored as `ABANDONED` with
a winner (`MatchTimeoutService`). It is *not* counted as a win or a loss: the
requirement is that outcomes are never inferred from disconnects, and the
stored status does not say the match was played to a result. The cost is that a
player who wins by their opponent leaving does not see that win in their
record. Counting it would be a product decision (and arguably a separate
"forfeits" figure), not something to infer here. Resignations and turn
timeouts are stored as `COMPLETED` with a winner and do count.

### Module wiring (PR 2)
`UsersModule` now imports `BlocksModule`, and `BlocksModule` imports
`AuthModule` and `RealtimeModule`, which import `UsersModule`/`AuthModule`.
That is a file-level import cycle (Realtime -> Auth -> Users -> Blocks ->
Realtime), so whichever module file loads first sees the others as `undefined`;
every edge on the cycle that Nest resolves lazily is a `forwardRef`. A boot-time
check that `AppModule` composes caught this before it was ever run against a
database.

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

### Planned (friends PR and later)
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
- Public profile (**implemented in PR 2**): id, username, display name, games
  played, wins, losses, draws. Never email, phone, date of birth, role, status,
  wallet or stakes. The avatar was left out: nothing in the product sets or
  shows one yet.

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
