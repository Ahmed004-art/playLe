import '../errors/app_exception.dart';
import '../network/api_client.dart';
import 'social_models.dart';

/// Read-only access to the public player data the API exposes (Phase 12):
/// profiles, batch summaries and the caller's own match history. Nothing here
/// writes, and nothing here touches wallet, stake or transaction data.
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
      queryParameters: {'limit': limit, if (cursor != null) 'cursor': cursor},
    );
    return _parse(() => MatchHistoryPage.fromJson(_asObject(response.data)));
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
