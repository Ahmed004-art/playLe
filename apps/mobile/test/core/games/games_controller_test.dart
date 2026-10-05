import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/games/games_controller.dart';
import 'package:playle_mobile/core/games/game_models.dart';

import 'fake_games_repository.dart';

void main() {
  group('GamesController', () {
    test('starts in GamesLoading before refresh is called', () {
      final controller = GamesController(FakeGamesRepository());
      expect(controller.state, isA<GamesLoading>());
    });

    test('refresh loads the catalog', () async {
      final controller = GamesController(FakeGamesRepository());

      await controller.refresh();

      final state = controller.state;
      expect(state, isA<GamesLoaded>());
      expect((state as GamesLoaded).games, [testGame]);
    });

    test('refresh surfaces an empty catalog without erroring', () async {
      final repo = FakeGamesRepository()..gamesToReturn = <GameInfo>[];
      final controller = GamesController(repo);

      await controller.refresh();

      final state = controller.state;
      expect(state, isA<GamesLoaded>());
      expect((state as GamesLoaded).games, isEmpty);
    });
  });
}
