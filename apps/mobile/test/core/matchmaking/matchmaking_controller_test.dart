import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/config/app_config.dart';
import 'package:playle_mobile/core/match_stakes/match_stake_models.dart';
import 'package:playle_mobile/core/matchmaking/matchmaking_controller.dart';
import 'package:playle_mobile/core/matchmaking/matchmaking_repository.dart';
import 'package:playle_mobile/core/matchmaking/matchmaking_state.dart';
import 'package:playle_mobile/core/network/websocket_client.dart';
import 'package:playle_mobile/core/realtime/realtime_connection_manager.dart';

import '../realtime/fake_secure_storage.dart';
import 'fake_matchmaking_repository.dart';

const _testConfig = AppConfig(
  environment: Environment.development,
  apiBaseUrl: 'http://localhost:0/api/v1',
  socketUrl: 'http://localhost:0',
);

RealtimeConnectionManager _fakeRealtime() => RealtimeConnectionManager(
  webSocketClient: WebSocketClient(config: _testConfig),
  secureStorage: FakeSecureStorage(),
);

void main() {
  group('MatchmakingController', () {
    test('starts in MatchmakingIdle', () {
      final controller = MatchmakingController(
        FakeMatchmakingRepository(),
        WebSocketClient(config: _testConfig),
        _fakeRealtime(),
      );
      expect(controller.state, isA<MatchmakingIdle>());
    });

    test(
      'join transitions to Searching, then Matched when the REST response says MATCHED',
      () async {
        final repo = FakeMatchmakingRepository()
          ..joinResult = const MatchmakingJoinResult(
            status: 'MATCHED',
            matchId: 'match-1',
          );
        final controller = MatchmakingController(
          repo,
          WebSocketClient(config: _testConfig),
          _fakeRealtime(),
        );

        final future = controller.join('tic_tac_toe');
        expect(controller.state, isA<MatchmakingSearching>());

        await future;

        final state = controller.state;
        expect(state, isA<MatchmakingMatched>());
        expect((state as MatchmakingMatched).matchId, 'match-1');
      },
    );

    test('join stays Searching when the REST response says QUEUED', () async {
      final controller = MatchmakingController(
        FakeMatchmakingRepository(),
        WebSocketClient(config: _testConfig),
        _fakeRealtime(),
      );

      await controller.join('tic_tac_toe');

      expect(controller.state, isA<MatchmakingSearching>());
    });

    test('cancel calls leave and returns to Idle', () async {
      final repo = FakeMatchmakingRepository();
      final controller = MatchmakingController(
        repo,
        WebSocketClient(config: _testConfig),
        _fakeRealtime(),
      );

      await controller.join('tic_tac_toe');
      await controller.cancel();

      expect(controller.state, isA<MatchmakingIdle>());
      expect(repo.left, isTrue);
    });

    test('join forwards the requested stake to the repository', () async {
      final repo = FakeMatchmakingRepository();
      final controller = MatchmakingController(
        repo,
        WebSocketClient(config: _testConfig),
        _fakeRealtime(),
      );
      const stake = MatchStakeRequest(amountMinor: '1000');

      await controller.join('tic_tac_toe', stake: stake);

      expect(repo.lastStakeRequested?.amountMinor, '1000');
    });

    test('join omits the stake (free play) when none is given', () async {
      final repo = FakeMatchmakingRepository();
      final controller = MatchmakingController(
        repo,
        WebSocketClient(config: _testConfig),
        _fakeRealtime(),
      );

      await controller.join('tic_tac_toe');

      expect(repo.lastStakeRequested, isNull);
    });
  });
}
