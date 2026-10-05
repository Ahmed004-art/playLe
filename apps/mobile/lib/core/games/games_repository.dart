import '../network/api_client.dart';
import 'game_models.dart';

abstract class GamesRepository {
  Future<List<GameInfo>> listGames();
}

class HttpGamesRepository implements GamesRepository {
  const HttpGamesRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<List<GameInfo>> listGames() async {
    final response = await apiClient.get<List<dynamic>>('/games');
    return response.data!
        .cast<Map<String, dynamic>>()
        .map(GameInfo.fromJson)
        .toList();
  }
}
