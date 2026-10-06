import '../match_stakes/match_stake_models.dart';
import '../network/api_client.dart';
import 'challenge_models.dart';

abstract class ChallengesRepository {
  /// [stake] is optional — omitting it is ordinary free play, unchanged
  /// from Phase 4. Immutable once the challenge is created.
  Future<ChallengeInfo> create(
    String gameId,
    String opponentUserId, {
    MatchStakeRequest? stake,
  });
  Future<List<ChallengeInfo>> list();
  Future<ChallengeInfo> accept(String challengeId);
  Future<ChallengeInfo> decline(String challengeId);
  Future<ChallengeInfo> cancel(String challengeId);

  /// Resolves an exact username to a user id — the only way this app
  /// identifies a challenge opponent, since there is no social/friends
  /// directory feature yet (see CLAUDE.md).
  Future<String> lookupUserIdByUsername(String username);
}

class HttpChallengesRepository implements ChallengesRepository {
  const HttpChallengesRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<ChallengeInfo> create(
    String gameId,
    String opponentUserId, {
    MatchStakeRequest? stake,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/challenges',
      data: {
        'gameId': gameId,
        'opponentUserId': opponentUserId,
        if (stake != null) 'stake': stake.toJson(),
      },
    );
    return ChallengeInfo.fromJson(response.data!);
  }

  @override
  Future<List<ChallengeInfo>> list() async {
    final response = await apiClient.get<Map<String, dynamic>>('/challenges');
    final items = response.data!['items'] as List<dynamic>;
    return items
        .cast<Map<String, dynamic>>()
        .map(ChallengeInfo.fromJson)
        .toList();
  }

  @override
  Future<ChallengeInfo> accept(String challengeId) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/challenges/$challengeId/accept',
    );
    return ChallengeInfo.fromJson(response.data!);
  }

  @override
  Future<ChallengeInfo> decline(String challengeId) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/challenges/$challengeId/decline',
    );
    return ChallengeInfo.fromJson(response.data!);
  }

  @override
  Future<ChallengeInfo> cancel(String challengeId) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/challenges/$challengeId/cancel',
    );
    return ChallengeInfo.fromJson(response.data!);
  }

  @override
  Future<String> lookupUserIdByUsername(String username) async {
    final response = await apiClient.get<Map<String, dynamic>>(
      '/users/lookup',
      queryParameters: {'username': username},
    );
    return response.data!['id'] as String;
  }
}
