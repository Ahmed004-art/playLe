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
| 3 | Friends: `FriendRequest`/`Friendship` (+ migration with CHECK constraints), request lifecycle and friends API, friends list with batch presence, block cascade to friendships and requests, per-player friend slots for the limits, `friend:request-received`/`friend:request-accepted` events | **Merged** (PR #17, `56d69c8`) |
| 4 | Flutter part 1: player profile screen, match history screen, social data layer, Account entries and routes | **Merged** (PR #18, `3a3a1ff`; Backend, Admin and Mobile CI green) |
| 5 | Flutter part 2: Friends screen (Friends / Requests / Blocked tabs), find a player, friend requests, remove friend, block / unblock, challenge a friend, realtime hints | Implemented locally on `feat/phase-12-mobile-friends`, **not pushed**. Locally: `dart format` clean, `dart analyze --fatal-infos` clean, `flutter test` **505 passed, 0 failed**. `flutter build apk --debug` NOT RUN (no Android SDK). Not run on a device or emulator. CI is not yet run on this branch. |

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

## PR 4 notes
Mobile only; no backend change. Everything here uses endpoints that already
exist on `main`.
- **Screens and routes** (all behind the existing auth redirect):
  `/players/:userId` (`PlayerProfileScreen`, any player, and the signed-in
  player's own profile) and `/history` (`MatchHistoryScreen`). `/history`, not
  `/matches/history`, because `/matches/:matchId` would claim it. The Account
  screen gains **My profile** and **Match history** buttons.
- **Profile** (`GET /users/:id/profile`): display name (falling back to the
  username when unset), `@username`, games played, wins, draws, losses, a
  proportional win/draw/loss bar and three stat tiles. There is no avatar image
  (the API has none); the avatar is the player's initials. Loading, retryable
  error, "Player not found" (404 and 400 look the same, as the API intends),
  and "session expired" states. A route id that is not a UUID never reaches the
  server.
- **Match history** (`GET /matches`, cursor-paged, plus one
  `GET /users/summaries` per page for opponent names and one `GET /games` for
  game names): game, opponent, result, how it ended and the date. **No
  backend dependency remains**: the endpoint existed from Phase 4 and already
  returns what is needed. Loading, empty, populated, error, retry, "Load more"
  and a retry for a failed next page. Tapping a row opens the opponent's profile
  when the match had exactly one opponent.
- **Result mapping** follows the stored result and the same rules as the
  server's statistics: Won / Lost / Draw only for a `COMPLETED` match whose
  stored result is consistent (a winner who is a player, or an explicit draw
  with no winner); `ABANDONED` is shown as abandoned even if a winner is stored
  (never inferred from a disconnect); `CANCELLED`/`EXPIRED` as cancelled;
  `WAITING`/`READY`/`ACTIVE` as in progress; anything inconsistent as "Result
  not recorded".
- **Not shown, and not available from the API to show:** stakes, money,
  settlement. The history contract carries none. There is no per-game or
  per-date filter (the server has none yet).
- **Names the API will not reveal** (a player with a block against the viewer
  in either direction, or an inactive one) are absent from the summaries
  response and are shown as "Player unavailable", never guessed.
- **Unauthorized (401).** The app has no global token-refresh-on-401 (refresh
  happens only when a saved session is restored at start-up), so a session that
  expires mid-use surfaces as a 401 on every screen. These two screens show
  "Your session has expired" with **Sign in again**, which calls the existing
  `AuthController.logout()` (the router then returns to the welcome screen). A
  global 401 handler would be a separate piece of work.
- **Data layer** (`core/social/`): typed models with defensive parsing (a
  missing statistic is an error, never `0`), `SocialRepository` (+ HTTP
  implementation), two `ChangeNotifier` controllers following the existing
  pattern. Controllers never double-fetch, drop replies that arrive after
  dispose, and keep networking out of `build`.
- **Verification.** Tests were written for models and parsing, the HTTP
  repository over a stubbed Dio adapter (paths, query, chunking at 50 ids,
  error mapping), both controllers, both screens (loading / error / retry / 404
  / 401 / empty / populated / pagination / navigation / privacy) and a
  320-390 px x 1.0-2.0x text layout matrix. **None of it has been run**: no
  Flutter SDK is available in the environment this was written in, so
  `flutter analyze`, `flutter test` and `dart format` are unverified, and
  nothing was seen on a device or emulator (OUTSTANDING_WORK items 22 and 25
  still apply).

## PR 5 notes
Mobile only; no backend change. Everything uses endpoints that already exist on
`main` (ADR-026, "Friends (PR 3)").
- **Screen and route**: `/friends` (`FriendsScreen`), opened from a new
  **Friends** button on the Account screen. Three tabs - **Friends**,
  **Requests** (Incoming and Sent) and **Blocked** - plus a **Find a player**
  action in the app bar (exact-username search).
- **Endpoints used**: `GET /friends` (with presence), `GET /friends/requests?
  direction=incoming|outgoing`, `POST /friends/requests`,
  `POST /friends/requests/:id/accept|decline|cancel`, `DELETE /friends/:userId`,
  `GET /blocks`, `POST /blocks`, `DELETE /blocks/:userId`,
  `GET /users/lookup?username=` (block-aware), `GET /games`, and the existing
  `POST /challenges` through `ChallengesController.challengeByUserId` (a small
  additive method; no username lookup needed). `ApiClient` gained `delete`.
- **Realtime**: `friend:request-received` and `friend:request-accepted`, via the
  existing `WebSocketClient`. They are **hints only**: an event makes the app
  re-fetch the affected lists, and the lists show what the server answers (an
  event the server does not back up changes nothing). Listeners are added once
  per screen and removed when it is disposed. Same limitation as the existing
  challenge events: `WebSocketClient.on` attaches to the current socket, so a
  later reconnect that replaces the socket drops them until the screen is
  reopened.
- **Confirmed responses only.** An action is sent; only after the server
  accepts it does anything change, and the affected lists are then re-fetched. A
  failure shows the server's own reason (e.g. "You have blocked this player",
  "This friend request is no longer pending") and, for a request that has
  already gone, re-fetches so the stale row disappears.
- **No duplicate submissions.** An action on a request, or on a player, is
  ignored while one is in flight for it (buttons are disabled and a spinner
  shows); a search cannot be started twice.
- **Blocking** follows the backend exactly: blocking asks for confirmation,
  then re-fetches every list (the server removes the friendship and cancels
  requests). **Unblocking restores nothing** - only the Blocked list is
  refreshed, and the message says friendships and requests are not restored.
- **Challenging** is offered only from the Friends tab (a friend can never be a
  blocked player; a blocked player is not on that list), is **free play only**
  (Plan decision 4: no stake UI), and picks a game from `GET /games`. The server
  decides whether it is allowed and its reason is shown as it is (blocked,
  already in a match, duplicate challenge); an unavailable player is "That
  player is unavailable right now." After sending, the snackbar offers **Open
  lobby**, since the opponent accepts from that game's lobby (existing flow).
- **Find a player** uses the block-aware lookup, so a player who has blocked you
  and one that does not exist both read "No player found with that username."
  The result card hints at the relationship from the **pages loaded so far**
  (friend / request sent / request received / blocked) and offers the matching
  action; the server still has the last word.
- **401** on a list shows "Your session has expired" with **Sign in again**
  (the existing `AuthController.logout()`); on an action, a snackbar with the
  same action. There is still no global refresh-on-401 (see PR 4 notes).
- **Verification actually run (locally, Dart/Flutter 3.12.2 / 3.44.4)**:
  `dart format --output=none --set-exit-if-changed .` clean;
  `dart analyze --fatal-infos` no issues; `flutter test` (the whole suite)
  **505 passed, 0 failed**, including 129 new tests for the models, the HTTP
  repository over a stubbed adapter, the paged-list and hub controllers
  (in-flight guards, block/unblock semantics, challenge errors, realtime
  subscribe/unsubscribe), and the screen (every tab and flow, 401, pagination,
  navigation, listener cleanup). **Not run**: `flutter build apk --debug` (no
  Android SDK here) and anything on a device or emulator; CI's Mobile job is the
  first Android build.
- **Limitations**: the friends list shows presence as last reported (up to ~30 s
  stale); lists are re-fetched rather than patched, so a very long list returns
  to its first page after an action; there is no search by display name (the API
  has none); no avatar images (the API has none).
## Verification standard
Each PR: API unit tests, typecheck, lint, format; Flutter analyze/test for
mobile PRs. Database-backed e2e suites run only in CI (no local database);
they are reported as unverified until CI has run them. Nothing here is
device-verified (OUTSTANDING_WORK items 22 and 25 still apply).

## Do not build
Wallet, ledger, payment, settlement, real-money or responsible-gaming changes;
chat, feed, groups, followers, a user directory or search; a new matchmaking
engine (including block-aware matchmaking); deployment work.
