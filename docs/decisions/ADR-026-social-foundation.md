# ADR-026: Social Foundation (blocking, pair lock, social throttling)

## Status
Accepted - Phase 12. Implemented so far: **blocking** (PR 1), **profiles,
summaries, statistics and block-aware lookup** (PR 2), and **friends, friend
requests, friend presence and realtime events** (PR 3). The Flutter screens
(PRs 4 and 5) are not started.

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
- **Friends cascade (PR 3).** Blocking also deletes an existing friendship and
  cancels a pending friend request between the pair (either direction), in the
  same transaction as the block and under the same pair lock. Nobody is told:
  a block must not announce itself. Presence is hidden between a blocked pair.
  Unblocking restores neither the friendship nor the request.

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
   challenge or friend-request row, before the friend slots (below), and before
   `createMatchGuarded`'s per-user locks. `block`/`unblock` lock the pair and
   then touch challenge and friend rows; challenge `accept` locks the pair and
   then claims the row and takes per-user match locks; friend `send`/`accept`
   lock the pair, then the friend slots, then touch friend rows. One consistent
   order is what rules out a deadlock between them.
2. Block, unblock, challenge-accept, friend-request send, friend-request accept
   and remove-friend take it. Challenge *creation* does not (it is advisory,
   matching the existing early checks in `create`); the authoritative block
   check is the one inside `accept`. Friend-request **decline and cancel** do
   not either: each is one conditional `UPDATE ... WHERE status = 'PENDING'` on
   one row, holds nothing else and asks for nothing else, so it cannot be part
   of a lock cycle, and a racing accept/block just finds the request no longer
   pending.

### Friend slots (PR 3)
The pair lock does not serialise two *different* pairs that share a player: A
accepting B and A accepting C hold different pair locks, so both could read 199
friends and both add one. `lockFriendSlots(tx, ...ids)` therefore also takes a
per-player advisory lock (`pg_advisory_xact_lock(1202, hashtext(userId))`, a key
space of its own), in sorted id order, after the pair lock. Whoever runs second
waits, then reads the committed count. It guards both the friend limit (200) and
the outgoing-pending-request limit (50).

Ordering argument: every transaction takes at most one pair lock, first; then
slots in sorted id order; nothing takes a slot lock and then a pair lock, and
none of these paths takes a `createMatchGuarded` per-user match lock, nor the
reverse. A theoretical `hashtext` collision between two ids could in principle
invert the effective order of two slot locks (the same caveat the existing
per-user match lock has); the worst case is a Postgres-detected deadlock that
aborts one request, never a hang or a wrong result.

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
limit of no existing endpoint. Block/unblock/list and friend-request **sending**
are marked (`POST /friends/requests`); accept, decline, cancel, remove and the
lists are not.

### Friends (PR 3)

**Schema** (one additive migration, `20261026150000_phase12_friends`):
- `FriendRequest(id, requesterId, addresseeId, status, pendingPairKey?,
  createdAt, respondedAt?)`. `pendingPairKey` is the sorted `lowId:highId` while
  PENDING and NULL after; its unique index is "at most one open request per
  unordered pair", and A->B and B->A share the key. Resolved requests never
  collide with anything.
- `Friendship(userLowId, userHighId, createdAt)`, primary key
  `(userLowId, userHighId)`: one row per unordered pair, always stored
  low < high.
- Hand-written CHECK constraints (Prisma cannot declare them), so the database
  refuses what the application should never write: `requesterId <> addresseeId`;
  `(status = 'PENDING') = (pendingPairKey IS NOT NULL)`; `pendingPairKey` equals
  the sorted pair of the two ids; `userLowId < userHighId` (which also forbids a
  self-friendship). Orderings use the `"C"` collation so the database and a
  JavaScript string sort always agree on which id is "low". Ids are the
  application's usual `TEXT` uuids; foreign keys cascade on user deletion.

**Routes** (all authenticated, `/api/v1`):

| Route | Behaviour |
|---|---|
| `POST /friends/requests` `{userId}` | Send. `201`. Crossed request -> accepts theirs (response `status: ACCEPTED`). |
| `GET /friends/requests?direction=incoming\|outgoing` | Pending requests, newest first, cursor-paged. Default incoming. |
| `POST /friends/requests/:id/accept` | Recipient only. |
| `POST /friends/requests/:id/decline` | Recipient only. |
| `POST /friends/requests/:id/cancel` | Sender only. |
| `GET /friends` | Friends with presence, cursor-paged. |
| `DELETE /friends/:userId` | Remove. `204`; `404` if not friends. |

A request response is `{id, status, direction, player: {id, username,
displayName}, createdAt, respondedAt}`; a friend is `{userId, username,
displayName, presence, friendsSince}`. Both are explicit allow-lists.

**Errors.** Malformed id `400`; self `400`; unknown or inactive player `404`; a
player who blocked the sender `404` with the body of an unknown player; the
blocker themselves `409 You have blocked this player`; a non-party `404`; the
wrong party `403`; duplicate request, already friends, a request that is no
longer pending, and either limit `409`. The 409 for the *other* player being at
the friend limit is deliberately vague so it does not reveal their list size.

**Crossed requests.** If B already has an open request to A when A sends one to
B, A's send accepts B's request instead: one friendship, the one request row
becomes ACCEPTED, no second row. It is serialised by the pair lock, so two
simultaneous crossed sends give exactly one friendship; the second to run does
the accepting. B is sent `friend:request-accepted`.

**Limits** (constants in `friends.constants.ts`): 200 friends per player and 50
outgoing pending requests per player. Enforced inside the transaction under the
friend slots (above), not by a trigger; accepting needs both players under 200.
A refusal rolls everything back, including the claim, so the request stays
PENDING.

**Presence.** Only `GET /friends` returns presence, and only for the friends it
returns: one `MGET` for those ids (`PresenceService.getMany`), never a Redis call
per friend, and no endpoint takes an id list. Redis being down reports everyone
`OFFLINE` instead of failing. A friendship row that is stale (a block exists
between the pair, or the friend is not ACTIVE) is left out of the list entirely
and its presence is never requested. This widens what `PresenceService`'s
doc comment says (previously: a current match opponent only) to "and accepted,
unblocked friends".

**Realtime.** Through the existing authenticated `user:{id}` rooms
(`RealtimeEmitterService.emitToUser`), only after the transaction commits, so a
rolled-back transaction emits nothing:
- `friend:request-received` -> the recipient: `{requestId, from: {id, username,
  displayName}}`.
- `friend:request-accepted` -> the original sender: `{requestId, friend: {id,
  username, displayName}}`.
Nothing is emitted for decline, cancel, remove or block. Delivery is
best-effort like every other event: if the gateway is not up the emit is
dropped and logged, never failing the REST call.

**Privacy summary.** Presence is never shown for a blocked pair or a non-friend;
lists never name a player with a block against the viewer; no event or response
carries email, phone, status, role, wallet or stake data.

### Public profile (PR 2)
Id, username, display name, games played, wins, losses, draws. Never email,
phone, date of birth, role, status, wallet or stakes. The avatar was left out:
nothing in the product sets or shows one yet.

### Remaining limitations
- No friend-slot or friend-limit **trigger**: the limits hold because every path
  that creates a friendship runs under the slot locks. A future code path that
  inserts into `friendships` directly must take them too (or the database should
  gain a constraint trigger).
- Decline and cancel take no pair lock (see above); a decline racing a crossed
  send can make that send fail with `409 no longer pending`, which a retry fixes.
- Removing a friend, declining and cancelling send no notification.
- A friend who has gone offline is shown `OFFLINE` for at most the presence TTL
  (30 s) after their last heartbeat is missed.

## Consequences
- Two additive migrations across the phase so far: `user_blocks` plus an index on
  `match_players(userId)` (PR 1), and `friend_requests`/`friendships` with their
  CHECK constraints (PR 3). No existing column changes, no backfill.
- `ChallengesService` gains a dependency on `BlocksService`; the accept
  transaction gains one advisory lock and one indexed read. Throughput impact is
  negligible for a per-pair lock.
- The `blocks` module is the single place that answers "are these two players
  blocked", so friends and profiles reuse `BlocksService.relationBetween`
  instead of re-deriving it.

## Not changed
Wallet, ledger, payments, settlement, eligibility, responsible gaming, real-money
flags, matchmaking behavior, and every existing route's rate limit.
