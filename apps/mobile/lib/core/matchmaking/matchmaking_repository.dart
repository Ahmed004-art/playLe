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
  Future<MatchmakingJoinResult> join(String gameId);
  Future<void> leave(String gameId);
}

class HttpMatchmakingRepository implements MatchmakingRepository {
  const HttpMatchmakingRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<MatchmakingJoinResult> join(String gameId) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/matchmaking/join',
      data: {'gameId': gameId},
    );
    return MatchmakingJoinResult.fromJson(response.data!);
  }

  @override
  Future<void> leave(String gameId) async {
    await apiClient.post<void>('/matchmaking/leave', data: {'gameId': gameId});
  }
}
