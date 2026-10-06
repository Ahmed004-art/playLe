import '../match_stakes/match_stake_models.dart';
import '../network/api_client.dart';

class MatchmakingJoinResult {
  const MatchmakingJoinResult({required this.status, this.matchId});

  factory MatchmakingJoinResult.fromJson(Map<String, dynamic> json) {
    return MatchmakingJoinResult(
      status: json['status'] as String,
      matchId: json['matchId'] as String?,
    );
  }

  /// "QUEUED" or "MATCHED". Only provisional — always listen for the
  /// `match:found` push too, since a concurrent join elsewhere can
  /// consume this user from the queue right after this call returns
  /// (see docs/decisions/ADR-015-game-module-architecture.md).
  final String status;
  final String? matchId;
}

abstract class MatchmakingRepository {
  /// [stake] is optional — omitting it is ordinary free play, unchanged
  /// from Phase 4. Only players who requested the identical stake
  /// amount+currency are ever paired together (see
  /// docs/decisions/ADR-016-match-financial-architecture.md).
  Future<MatchmakingJoinResult> join(String gameId, {MatchStakeRequest? stake});
  Future<void> leave(String gameId);
}

class HttpMatchmakingRepository implements MatchmakingRepository {
  const HttpMatchmakingRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<MatchmakingJoinResult> join(
    String gameId, {
    MatchStakeRequest? stake,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/matchmaking/join',
      data: {'gameId': gameId, if (stake != null) 'stake': stake.toJson()},
    );
    return MatchmakingJoinResult.fromJson(response.data!);
  }

  @override
  Future<void> leave(String gameId) async {
    await apiClient.post<void>('/matchmaking/leave', data: {'gameId': gameId});
  }
}
