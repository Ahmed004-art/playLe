import '../network/api_client.dart';
import '../utils/uuid.dart';
import 'match_models.dart';

abstract class MatchRepository {
  Future<MatchInfo> getMatch(String matchId);
  Future<List<MatchInfo>> listMatches();
  Future<CommandResult> submitCommand(
    String matchId,
    Map<String, dynamic> payload,
  );
}

class HttpMatchRepository implements MatchRepository {
  const HttpMatchRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<MatchInfo> getMatch(String matchId) async {
    final response = await apiClient.get<Map<String, dynamic>>(
      '/matches/$matchId',
    );
    return MatchInfo.fromJson(response.data!);
  }

  @override
  Future<List<MatchInfo>> listMatches() async {
    final response = await apiClient.get<Map<String, dynamic>>('/matches');
    final items = response.data!['items'] as List<dynamic>;
    return items.cast<Map<String, dynamic>>().map(MatchInfo.fromJson).toList();
  }

  @override
  Future<CommandResult> submitCommand(
    String matchId,
    Map<String, dynamic> payload,
  ) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/matches/$matchId/commands',
      data: {'commandId': generateUuidV4(), 'payload': payload},
    );
    return CommandResult.fromJson(response.data!);
  }
}
