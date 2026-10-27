import 'dart:async';

import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/social/social_models.dart';
import 'package:playle_mobile/core/social/social_repository.dart';

// Well-formed ids: the app rejects a route id that is not a UUID before it
// ever asks the server, so test ids must be real UUIDs.
const myId = '11111111-1111-4111-8111-111111111111';
const opponentId = '22222222-2222-4222-8222-222222222222';
const otherOpponentId = '33333333-3333-4333-8333-333333333333';
const thirdPlayerId = '44444444-4444-4444-8444-444444444444';

PlayerProfile buildProfile({
  String id = opponentId,
  String username = 'ada_l',
  String? displayName = 'Ada Lovelace',
  int gamesPlayed = 10,
  int wins = 6,
  int losses = 3,
  int draws = 1,
}) {
  return PlayerProfile(
    id: id,
    username: username,
    displayName: displayName,
    gamesPlayed: gamesPlayed,
    wins: wins,
    losses: losses,
    draws: draws,
  );
}

MatchHistoryEntry buildMatch({
  required String id,
  String gameId = 'tic_tac_toe',
  String status = 'COMPLETED',
  String? winnerUserId,
  bool resultIsDraw = false,
  String? terminationReason,
  List<String>? players,
  DateTime? createdAt,
  DateTime? completedAt,
}) {
  return MatchHistoryEntry(
    id: id,
    gameId: gameId,
    status: status,
    winnerUserId: winnerUserId,
    resultIsDraw: resultIsDraw,
    terminationReason: terminationReason,
    playerUserIds: players ?? [myId, opponentId],
    createdAt: createdAt ?? DateTime.utc(2026, 10, 20, 12),
    completedAt: completedAt,
  );
}

FriendInfo buildFriend({
  String userId = opponentId,
  String username = 'ada_l',
  String? displayName = 'Ada Lovelace',
  FriendPresence presence = FriendPresence.offline,
}) {
  return FriendInfo(
    userId: userId,
    username: username,
    displayName: displayName,
    presence: presence,
    friendsSince: DateTime.utc(2026, 10, 1, 12),
  );
}

FriendRequestInfo buildRequest({
  String id = 'request-1',
  FriendRequestDirection direction = FriendRequestDirection.incoming,
  String status = 'PENDING',
  String playerId = opponentId,
  String username = 'ada_l',
  String? displayName = 'Ada Lovelace',
}) {
  return FriendRequestInfo(
    id: id,
    status: status,
    direction: direction,
    player: PlayerSummary(
      id: playerId,
      username: username,
      displayName: displayName,
    ),
    createdAt: DateTime.utc(2026, 10, 2, 12),
    respondedAt: null,
  );
}

BlockedPlayer buildBlocked({
  String userId = opponentId,
  String username = 'ada_l',
  String? displayName = 'Ada Lovelace',
}) {
  return BlockedPlayer(
    userId: userId,
    username: username,
    displayName: displayName,
    blockedAt: DateTime.utc(2026, 10, 3, 12),
  );
}

/// A controllable [SocialRepository] for controller and widget tests.
///
/// Profile, summaries and match history are scripted (see their fields). The
/// friends, friend-request and block parts behave like a small in-memory
/// server: accepting a request moves it into [friends], blocking someone
/// removes any friendship and requests with them, and unblocking removes only
/// the block - it restores nothing, like the real API.
class FakeSocialRepository implements SocialRepository {
  // ---- profile, summaries, history (Phase 12 PR 4) -------------------------

  PlayerProfile? profileToReturn;
  Object? profileError;

  /// When set, [getProfile] waits for it, so a test can hold a request in
  /// flight (to prove nothing is fetched twice, or a late reply is ignored).
  Completer<void>? profileGate;
  int profileCalls = 0;
  final List<String> profileRequests = [];

  List<PlayerSummary> summariesToReturn = [];
  Object? summariesError;
  final List<List<String>> summaryRequests = [];

  /// Pages returned by successive [getMatchHistory] calls (the first call gets
  /// the first page, and so on). Past the end an empty last page is returned.
  List<MatchHistoryPage> pages = [];
  final Map<int, Object> historyErrorsByCall = {};
  final List<String?> historyCursors = [];
  int historyCalls = 0;

  @override
  Future<PlayerProfile> getProfile(String userId) async {
    profileCalls++;
    profileRequests.add(userId);
    final gate = profileGate;
    if (gate != null) {
      await gate.future;
    }
    final error = profileError;
    if (error != null) {
      throw error;
    }
    return profileToReturn ?? buildProfile(id: userId);
  }

  @override
  Future<List<PlayerSummary>> getSummaries(List<String> userIds) async {
    summaryRequests.add(List<String>.of(userIds));
    final error = summariesError;
    if (error != null) {
      throw error;
    }
    return summariesToReturn;
  }

  @override
  Future<MatchHistoryPage> getMatchHistory({
    String? cursor,
    int limit = 20,
  }) async {
    final call = historyCalls++;
    historyCursors.add(cursor);
    final error = historyErrorsByCall[call];
    if (error != null) {
      throw error;
    }
    if (call < pages.length) {
      return pages[call];
    }
    return const MatchHistoryPage(items: [], nextCursor: null);
  }

  // ---- friends, requests, blocks (Phase 12 PR 5) ---------------------------

  final List<FriendInfo> friends = [];
  final List<FriendRequestInfo> incoming = [];
  final List<FriendRequestInfo> outgoing = [];
  final List<BlockedPlayer> blocks = [];

  /// Players the "server" knows, by user id: used to answer a send, a block or
  /// a lookup. A username lookup finds the entry with that username.
  final Map<String, PlayerSummary> directory = {};

  /// Makes the named call throw this, until removed. Names: `friends`,
  /// `incoming`, `outgoing`, `blocks`, `send`, `accept`, `decline`, `cancel`,
  /// `remove`, `block`, `unblock`, `lookup`.
  final Map<String, Object> errors = {};

  /// Makes the named call wait for the completer before doing anything.
  final Map<String, Completer<void>> gates = {};

  /// How many times each named call was made.
  final Map<String, int> calls = {};

  /// Every call made, in order, e.g. `accept:request-1`, `friends`.
  final List<String> log = [];

  final List<String?> friendCursors = [];
  int _requestSeq = 0;

  int callsTo(String name) => calls[name] ?? 0;

  Future<void> _enter(String name, [String? detail]) async {
    calls[name] = callsTo(name) + 1;
    log.add(detail == null ? name : '$name:$detail');
    final gate = gates[name];
    if (gate != null) {
      await gate.future;
    }
    final error = errors[name];
    if (error != null) {
      throw error;
    }
  }

  SocialPage<T> _page<T>(
    List<T> all,
    String? cursor,
    int limit,
    String Function(T item) idOf,
  ) {
    var start = 0;
    if (cursor != null) {
      start = all.indexWhere((item) => idOf(item) == cursor) + 1;
    }
    final items = all.skip(start).take(limit).toList();
    final hasMore = start + items.length < all.length;
    return SocialPage<T>(
      items: items,
      nextCursor: hasMore ? idOf(items.last) : null,
    );
  }

  @override
  Future<SocialPage<FriendInfo>> getFriends({
    String? cursor,
    int limit = 20,
  }) async {
    friendCursors.add(cursor);
    await _enter('friends');
    return _page(friends, cursor, limit, (f) => f.userId);
  }

  @override
  Future<SocialPage<FriendRequestInfo>> getFriendRequests(
    FriendRequestDirection direction, {
    String? cursor,
    int limit = 20,
  }) async {
    final name = direction == FriendRequestDirection.incoming
        ? 'incoming'
        : 'outgoing';
    await _enter(name);
    final all = direction == FriendRequestDirection.incoming
        ? incoming
        : outgoing;
    return _page(all, cursor, limit, (r) => r.id);
  }

  @override
  Future<SocialPage<BlockedPlayer>> getBlocks({
    String? cursor,
    int limit = 20,
  }) async {
    await _enter('blocks');
    return _page(blocks, cursor, limit, (b) => b.userId);
  }

  @override
  Future<FriendRequestInfo> sendFriendRequest(String userId) async {
    await _enter('send', userId);
    final player = directory[userId];
    if (player == null) {
      throw const NetworkException('Player not found', statusCode: 404);
    }
    // Crossed: they had already asked, so theirs is accepted instead.
    final theirs = incoming.where((r) => r.player.id == userId).toList();
    if (theirs.isNotEmpty) {
      incoming.remove(theirs.first);
      friends.add(_friendFrom(player));
      return _copy(theirs.first, status: 'ACCEPTED');
    }
    final request = FriendRequestInfo(
      id: 'sent-${++_requestSeq}',
      status: 'PENDING',
      direction: FriendRequestDirection.outgoing,
      player: player,
      createdAt: DateTime.utc(2026, 10, 4, 12),
      respondedAt: null,
    );
    outgoing.add(request);
    return request;
  }

  @override
  Future<FriendRequestInfo> acceptFriendRequest(String requestId) async {
    await _enter('accept', requestId);
    final request = incoming.firstWhere(
      (r) => r.id == requestId,
      orElse: () => throw const NetworkException(
        'This friend request is no longer pending',
        statusCode: 409,
      ),
    );
    incoming.remove(request);
    friends.add(_friendFrom(request.player));
    return _copy(request, status: 'ACCEPTED');
  }

  @override
  Future<FriendRequestInfo> declineFriendRequest(String requestId) async {
    await _enter('decline', requestId);
    final request = incoming.firstWhere(
      (r) => r.id == requestId,
      orElse: () => throw const NetworkException(
        'This friend request is no longer pending',
        statusCode: 409,
      ),
    );
    incoming.remove(request);
    return _copy(request, status: 'DECLINED');
  }

  @override
  Future<FriendRequestInfo> cancelFriendRequest(String requestId) async {
    await _enter('cancel', requestId);
    final request = outgoing.firstWhere(
      (r) => r.id == requestId,
      orElse: () => throw const NetworkException(
        'This friend request is no longer pending',
        statusCode: 409,
      ),
    );
    outgoing.remove(request);
    return _copy(request, status: 'CANCELLED');
  }

  @override
  Future<void> removeFriend(String userId) async {
    await _enter('remove', userId);
    final before = friends.length;
    friends.removeWhere((f) => f.userId == userId);
    if (friends.length == before) {
      throw const NetworkException('Friend not found', statusCode: 404);
    }
  }

  @override
  Future<BlockedPlayer> blockPlayer(String userId) async {
    await _enter('block', userId);
    final player = directory[userId];
    if (player == null) {
      throw const NetworkException('Player not found', statusCode: 404);
    }
    // The server removes the friendship and cancels pending requests.
    friends.removeWhere((f) => f.userId == userId);
    incoming.removeWhere((r) => r.player.id == userId);
    outgoing.removeWhere((r) => r.player.id == userId);
    if (!blocks.any((b) => b.userId == userId)) {
      blocks.add(
        BlockedPlayer(
          userId: userId,
          username: player.username,
          displayName: player.displayName,
          blockedAt: DateTime.utc(2026, 10, 5, 12),
        ),
      );
    }
    return blocks.firstWhere((b) => b.userId == userId);
  }

  @override
  Future<void> unblockPlayer(String userId) async {
    await _enter('unblock', userId);
    // Removes only the block. Restores no friendship and no request.
    blocks.removeWhere((b) => b.userId == userId);
  }

  @override
  Future<PlayerLookupResult> lookupPlayer(String username) async {
    await _enter('lookup', username);
    for (final entry in directory.entries) {
      if (entry.value.username == username) {
        return PlayerLookupResult(id: entry.key, username: username);
      }
    }
    throw const NetworkException(
      'No account with that username',
      statusCode: 404,
    );
  }

  FriendInfo _friendFrom(PlayerSummary player) => FriendInfo(
    userId: player.id,
    username: player.username,
    displayName: player.displayName,
    presence: FriendPresence.offline,
    friendsSince: DateTime.utc(2026, 10, 6, 12),
  );

  FriendRequestInfo _copy(FriendRequestInfo r, {required String status}) {
    return FriendRequestInfo(
      id: r.id,
      status: status,
      direction: r.direction,
      player: r.player,
      createdAt: r.createdAt,
      respondedAt: DateTime.utc(2026, 10, 7, 12),
    );
  }
}
