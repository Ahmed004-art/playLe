import '../errors/app_exception.dart';
import '../network/api_client.dart';
import 'social_models.dart';

/// Access to the Phase 12 social API: public profiles, batch summaries, the
/// caller's own match history, friends and friend requests, and blocks.
///
/// Every method maps onto exactly one existing endpoint and returns what the
/// server confirmed; nothing here guesses, caches or applies a change locally.
/// Nothing here touches wallet, stake or transaction data.
///
/// Failures are [NetworkException]s carrying the HTTP status (401 = session
/// expired, 404 = not found or hidden, 409 = a conflict such as a duplicate
/// request or a limit), or `null` status for no connection.
abstract class SocialRepository {
  /// `GET /users/:id/profile`. Throws a [NetworkException] with status 404
  /// for a player who does not exist or may not be seen (the API makes those
  /// indistinguishable on purpose) and 400 for a malformed id.
  Future<PlayerProfile> getProfile(String userId);

  /// `GET /users/summaries?ids=`. Players the API will not reveal (missing,
  /// inactive, or any block between the two players) are simply absent from
  /// the result - the caller must cope with a shorter list. Chunks the ids so
  /// each request stays within the API's 50-id limit.
  Future<List<PlayerSummary>> getSummaries(List<String> userIds);

  /// `GET /matches`: one page of the caller's own matches, newest first.
  /// Pass the previous page's `nextCursor` as [cursor] for the next page.
  Future<MatchHistoryPage> getMatchHistory({String? cursor, int limit = 20});

  /// `GET /users/lookup?username=`: resolves an exact username. 404 for an
  /// unknown username *and* for a player who has blocked the caller.
  Future<PlayerLookupResult> lookupPlayer(String username);

  /// `GET /friends`: the caller's friends with best-effort presence.
  Future<SocialPage<FriendInfo>> getFriends({String? cursor, int limit = 20});

  /// `DELETE /friends/:userId`. 404 if they are not a friend.
  Future<void> removeFriend(String userId);

  /// `GET /friends/requests?direction=`: pending requests, newest first.
  Future<SocialPage<FriendRequestInfo>> getFriendRequests(
    FriendRequestDirection direction, {
    String? cursor,
    int limit = 20,
  });

  /// `POST /friends/requests`. If the other player had already asked, their
  /// request is accepted and the result is `ACCEPTED`. 409 for a duplicate,
  /// an existing friend, a player you have blocked, or a limit; 404 for an
  /// unknown player or one who has blocked you.
  Future<FriendRequestInfo> sendFriendRequest(String userId);

  /// `POST /friends/requests/:id/accept` (recipient only).
  Future<FriendRequestInfo> acceptFriendRequest(String requestId);

  /// `POST /friends/requests/:id/decline` (recipient only).
  Future<FriendRequestInfo> declineFriendRequest(String requestId);

  /// `POST /friends/requests/:id/cancel` (sender only).
  Future<FriendRequestInfo> cancelFriendRequest(String requestId);

  /// `GET /blocks`: the players the caller has blocked (never who has blocked
  /// the caller).
  Future<SocialPage<BlockedPlayer>> getBlocks({String? cursor, int limit = 20});

  /// `POST /blocks`: idempotent. The server also removes any friendship and
  /// cancels any pending friend request or challenge between the two.
  Future<BlockedPlayer> blockPlayer(String userId);

  /// `DELETE /blocks/:userId`: idempotent. Restores nothing the block removed.
  Future<void> unblockPlayer(String userId);
}

/// The most ids one summaries request may carry (the API rejects more).
const int maxSummaryIdsPerRequest = 50;

class HttpSocialRepository implements SocialRepository {
  const HttpSocialRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<PlayerProfile> getProfile(String userId) async {
    final response = await apiClient.get<Map<String, dynamic>>(
      '/users/$userId/profile',
    );
    return _parse(() => PlayerProfile.fromJson(_asObject(response.data)));
  }

  @override
  Future<List<PlayerSummary>> getSummaries(List<String> userIds) async {
    final unique = userIds.toSet().toList();
    final summaries = <PlayerSummary>[];
    for (
      var start = 0;
      start < unique.length;
      start += maxSummaryIdsPerRequest
    ) {
      final end = start + maxSummaryIdsPerRequest < unique.length
          ? start + maxSummaryIdsPerRequest
          : unique.length;
      final response = await apiClient.get<Map<String, dynamic>>(
        '/users/summaries',
        queryParameters: {'ids': unique.sublist(start, end).join(',')},
      );
      final body = _asObject(response.data);
      final items = _parse(() {
        final raw = body['items'];
        if (raw is! List) {
          throw const FormatException('Expected a list for "items"');
        }
        return raw.map((item) {
          if (item is! Map) {
            throw const FormatException('Expected an object in "items"');
          }
          return PlayerSummary.fromJson(Map<String, dynamic>.from(item));
        }).toList();
      });
      summaries.addAll(items);
    }
    return summaries;
  }

  @override
  Future<MatchHistoryPage> getMatchHistory({
    String? cursor,
    int limit = 20,
  }) async {
    final response = await apiClient.get<Map<String, dynamic>>(
      '/matches',
      queryParameters: {'limit': limit, 'cursor': ?cursor},
    );
    return _parse(() => MatchHistoryPage.fromJson(_asObject(response.data)));
  }

  @override
  Future<PlayerLookupResult> lookupPlayer(String username) async {
    final response = await apiClient.get<Map<String, dynamic>>(
      '/users/lookup',
      queryParameters: {'username': username},
    );
    return _parse(() => PlayerLookupResult.fromJson(_asObject(response.data)));
  }

  @override
  Future<SocialPage<FriendInfo>> getFriends({
    String? cursor,
    int limit = 20,
  }) async {
    final response = await apiClient.get<Map<String, dynamic>>(
      '/friends',
      queryParameters: {'limit': limit, 'cursor': ?cursor},
    );
    return _parse(
      () => SocialPage.parse(_asObject(response.data), FriendInfo.fromJson),
    );
  }

  @override
  Future<void> removeFriend(String userId) async {
    await apiClient.delete<void>('/friends/$userId');
  }

  @override
  Future<SocialPage<FriendRequestInfo>> getFriendRequests(
    FriendRequestDirection direction, {
    String? cursor,
    int limit = 20,
  }) async {
    final response = await apiClient.get<Map<String, dynamic>>(
      '/friends/requests',
      queryParameters: {
        'direction': direction.apiValue,
        'limit': limit,
        'cursor': ?cursor,
      },
    );
    return _parse(
      () => SocialPage.parse(
        _asObject(response.data),
        FriendRequestInfo.fromJson,
      ),
    );
  }

  @override
  Future<FriendRequestInfo> sendFriendRequest(String userId) =>
      _requestAction('/friends/requests', data: {'userId': userId});

  @override
  Future<FriendRequestInfo> acceptFriendRequest(String requestId) =>
      _requestAction('/friends/requests/$requestId/accept');

  @override
  Future<FriendRequestInfo> declineFriendRequest(String requestId) =>
      _requestAction('/friends/requests/$requestId/decline');

  @override
  Future<FriendRequestInfo> cancelFriendRequest(String requestId) =>
      _requestAction('/friends/requests/$requestId/cancel');

  Future<FriendRequestInfo> _requestAction(
    String path, {
    Map<String, dynamic>? data,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      path,
      data: data,
    );
    return _parse(() => FriendRequestInfo.fromJson(_asObject(response.data)));
  }

  @override
  Future<SocialPage<BlockedPlayer>> getBlocks({
    String? cursor,
    int limit = 20,
  }) async {
    final response = await apiClient.get<Map<String, dynamic>>(
      '/blocks',
      queryParameters: {'limit': limit, 'cursor': ?cursor},
    );
    return _parse(
      () => SocialPage.parse(_asObject(response.data), BlockedPlayer.fromJson),
    );
  }

  @override
  Future<BlockedPlayer> blockPlayer(String userId) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/blocks',
      data: {'userId': userId},
    );
    return _parse(() => BlockedPlayer.fromJson(_asObject(response.data)));
  }

  @override
  Future<void> unblockPlayer(String userId) async {
    await apiClient.delete<void>('/blocks/$userId');
  }

  Map<String, dynamic> _asObject(Object? data) {
    if (data is Map) {
      return Map<String, dynamic>.from(data);
    }
    throw const NetworkException(
      'The server sent a response this app does not understand.',
    );
  }

  /// A malformed body is a server/app mismatch, not a crash: surface it as the
  /// app's own error type so every caller handles it like any other failure.
  T _parse<T>(T Function() parse) {
    try {
      return parse();
    } on FormatException {
      throw const NetworkException(
        'The server sent a response this app does not understand.',
      );
    }
  }
}
