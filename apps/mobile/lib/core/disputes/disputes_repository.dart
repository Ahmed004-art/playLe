import '../network/api_client.dart';
import 'dispute_models.dart';

/// The user's own disputes abstraction — mirrors
/// `core/challenges/challenges_repository.dart`'s shape exactly. The UI
/// never talks to [ApiClient] directly.
abstract class DisputesRepository {
  Future<List<DisputeInfo>> list();

  /// Files a dispute against a completed/abandoned match the caller
  /// played in. [reason] must be at least 10 characters — the server
  /// enforces this too, so a client-side check is purely for fast
  /// feedback, never the source of truth.
  Future<DisputeInfo> create(String matchId, String reason);
}

class HttpDisputesRepository implements DisputesRepository {
  const HttpDisputesRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<List<DisputeInfo>> list() async {
    final response = await apiClient.get<Map<String, dynamic>>('/disputes');
    final items = response.data!['items'] as List<dynamic>;
    return items
        .cast<Map<String, dynamic>>()
        .map(DisputeInfo.fromJson)
        .toList();
  }

  @override
  Future<DisputeInfo> create(String matchId, String reason) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/matches/$matchId/dispute',
      data: {'reason': reason},
    );
    return DisputeInfo.fromJson(response.data!);
  }
}
