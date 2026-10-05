import 'package:playle_mobile/core/games/game_models.dart';
import 'package:playle_mobile/core/games/games_repository.dart';

const testGame = GameInfo(
  id: 'tic_tac_toe',
  displayName: 'Tic-Tac-Toe',
  description: 'Classic 3x3 grid — three in a row wins.',
  minPlayers: 2,
  maxPlayers: 2,
);

class FakeGamesRepository implements GamesRepository {
  List<GameInfo> gamesToReturn = [testGame];

  @override
  Future<List<GameInfo>> listGames() async => gamesToReturn;
}
