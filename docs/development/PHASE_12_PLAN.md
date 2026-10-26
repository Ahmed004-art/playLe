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
   (max 50 unique; id, username, display name only; hides a player when a block
   exists in **either** direction). The `GET /matches` response is unchanged.
2. Crossed friend requests auto-accept.
3. A profile is visible to any signed-in player who has the id, except one who
   has blocked them (the blocker can still open the profile of a player they
   blocked, to unblock them).
4. Friend challenges are free play only in this phase.
5. Disconnect forfeits are stored as `ABANDONED` (with a winner), so they are
   **not** counted in win/loss statistics; stats count consistent `COMPLETED`
   matches only (PR 2 verified this in `MatchTimeoutService`).

## PR sequence and status

| # | PR | Status |
|---|---|---|
| 1 | Blocking foundation: `user_blocks` migration, `match_players(userId)` index, block/unblock/list API, block checks in challenge create and accept, pair lock, opt-in `social` throttler, ADR-026 | **Merged** (PR #15, `462bc6b`; CI green) |
| 2 | Profiles and stats: `GET users/:id/profile`, `GET users/summaries`, block-aware `GET users/lookup`, `BlocksService.relationsBetween`, one shared visibility policy | **Merged** (PR #16, `7098c2b`) |
| 3 | Friends: `FriendRequest`/`Friendship` (+ migration with CHECK constraints), request lifecycle and friends API, friends list with batch presence, block cascade to friendships and requests, per-player friend slots for the limits, `friend:request-received`/`friend:request-accepted` events | Implemented locally on `feat/phase-12-friends-presence`, **not pushed**; database-backed tests unverified until CI |
| 4 | Flutter part 1: social models/controller, match history, profile screen, navigation | Not started |
| 5 | Flutter part 2: friends/requests/blocked screens, challenge from friend | Not started |

## PR 1 notes
- **Block cascade to friendships and friend requests** could not exist before
  those models did; it landed in PR 3 (below), in the same transaction as the
  block, behind the same pair lock.
- `users/lookup` was not block-aware in PR 1; closed in PR 2 (below).
- Random matchmaking is unchanged and may still pair a blocked pair.
- The `social` throttler is opt-in (`@SocialThrottle()`); registering it did not
  change any existing route's limit.

## PR 2 notes
- **No migration.** The `match_players(userId)` index PR 1 added is what the
  statistics query uses.
- **Statistics rules and the forfeit limitation** are in ADR-026, "Match
  statistics". In short: only consistent `COMPLETED` matches count, so
  `gamesPlayed = wins + losses + draws`; a disconnect forfeit (stored
  `ABANDONED`) is not counted, which means a win by the opponent leaving does
  not show in a player's record. Counting it is a product decision.
- **Avatar is not in the profile**: nothing sets or shows one yet.
- **Module cycle.** `UsersModule` -> `BlocksModule` -> `RealtimeModule`/
  `AuthModule` -> `UsersModule` needed `forwardRef` on `BlocksModule`'s
  `AuthModule` and `RealtimeModule` imports and on `UsersModule`'s
  `BlocksModule` import. Verified by compiling `AppModule` in a throwaway
  test (not committed: it took about a minute and cannot shut down cleanly
  without Redis); CI's e2e suites boot the whole app and will exercise it too.
- **The statistics SQL has not been run against Postgres locally** (no local
  database). Unit tests prove the query's shape and the service around it;
  `test/profiles.e2e-spec.ts` proves the counting against real rows, in CI only.
- Summaries and profiles are not marked `@SocialThrottle()`: they are read
  endpoints that lists will call often.

## PR 3 notes
Full design, error semantics and limitations: ADR-026, "Friends (PR 3)".
- **Migration `20261026150000_phase12_friends`** (additive, not applied to any
  environment): `friend_requests` and `friendships` plus hand-written CHECK
  constraints (no self request, `pendingPairKey` set exactly while PENDING and
  equal to the sorted pair, friendship stored `low < high`). `prisma validate`
  passes; **it has not been applied to a real Postgres here**, so the CHECK
  syntax and the `"C"` collation comparisons are verified only by CI's e2e run
  (`test/friends.e2e-spec.ts` writes rows directly to prove each constraint).
- **API**: `POST/GET /friends/requests`, `POST /friends/requests/:id/accept|
  decline|cancel`, `GET /friends`, `DELETE /friends/:userId`. Only sending is
  `@SocialThrottle()`d.
- **Limits**: 200 friends, 50 outgoing pending requests, enforced in the
  transaction under per-player friend slots (`lockFriendSlots`), taken after
  the pair lock. This is what makes two accepts at 199 friends yield exactly
  200. There is no database trigger behind the limits (documented limitation).
- **Crossed requests** auto-accept: one friendship, one request row.
- **Blocking** now deletes the friendship and cancels a pending request in the
  same transaction; unblocking restores nothing.
- **Presence**: `GET /friends` only; one `MGET` through `PresenceService.getMany`;
  `OFFLINE` if Redis fails; never for a blocked pair or a non-friend.
- **Realtime**: `friend:request-received` (to the recipient) and
  `friend:request-accepted` (to the original sender), after commit, minimal
  payload, via the existing authenticated user rooms.
- **Module wiring**: `FriendsModule` imports `AuthModule`, `BlocksModule` and
  `RealtimeModule` directly (it is not part of the Users/Blocks/Auth/Realtime
  import cycle). Verified by composing `AppModule` in a throwaway test.
- Not built: Flutter screens, any friends UI, challenge-from-friend (PRs 4-5).

## Verification standard
Each PR: API unit tests, typecheck, lint, format; Flutter analyze/test for
mobile PRs. Database-backed e2e suites run only in CI (no local database);
they are reported as unverified until CI has run them. Nothing here is
device-verified (OUTSTANDING_WORK items 22 and 25 still apply).

## Do not build
Wallet, ledger, payment, settlement, real-money or responsible-gaming changes;
chat, feed, groups, followers, a user directory or search; a new matchmaking
engine (including block-aware matchmaking); deployment work.
