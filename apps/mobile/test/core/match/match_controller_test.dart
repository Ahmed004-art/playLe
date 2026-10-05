import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/config/app_config.dart';
import 'package:playle_mobile/core/match/match_controller.dart';
import 'package:playle_mobile/core/match/match_models.dart';
import 'package:playle_mobile/core/match/match_state.dart';
import 'package:playle_mobile/core/network/websocket_client.dart';
import 'package:playle_mobile/core/realtime/realtime_connection_manager.dart';

import '../realtime/fake_secure_storage.dart';
import 'fake_match_repository.dart';

const _testConfig = AppConfig(
  environment: Environment.development,
  apiBaseUrl: 'http://localhost:0/api/v1',
  socketUrl: 'http://localhost:0',
);

MatchController _buildController(FakeMatchRepository repo) => MatchController(
  repo,
  WebSocketClient(config: _testConfig),
  RealtimeConnectionManager(
    webSocketClient: WebSocketClient(config: _testConfig),
    secureStorage: FakeSecureStorage(),
  ),
);

void main() {
  group('MatchController', () {
    test('starts in MatchViewLoading before loadMatch is called', () {
      final controller = _buildController(FakeMatchRepository());
      expect(controller.state, isA<MatchViewLoading>());
    });

    test('loadMatch loads the match', () async {
      final repo = FakeMatchRepository()..matchToReturn = buildTestMatch();
      final controller = _buildController(repo);

      await controller.loadMatch('match-1');

      final state = controller.state;
      expect(state, isA<MatchViewLoaded>());
      expect((state as MatchViewLoaded).match.id, 'match-1');
      expect(state.lastRejection, isNull);
    });

    test(
      'submitMove sends the payload and reloads the match with no rejection on success',
      () async {
        final repo = FakeMatchRepository()
          ..matchToReturn = buildTestMatch()
          ..commandResultToReturn = const CommandResult(
            resultStatus: 'ACCEPTED',
            rejectionReason: null,
          );
        final controller = _buildController(repo);
        await controller.loadMatch('match-1');

        await controller.submitMove({'cell': 4});

        expect(repo.submittedPayloads, [
          {'cell': 4},
        ]);
        final state = controller.state;
        expect(state, isA<MatchViewLoaded>());
        expect((state as MatchViewLoaded).lastRejection, isNull);
      },
    );

    test('submitMove surfaces the rejection reason without erroring', () async {
      final repo = FakeMatchRepository()
        ..matchToReturn = buildTestMatch()
        ..commandResultToReturn = const CommandResult(
          resultStatus: 'REJECTED',
          rejectionReason: 'Not your turn',
        );
      final controller = _buildController(repo);
      await controller.loadMatch('match-1');

      await controller.submitMove({'cell': 0});

      final state = controller.state;
      expect(state, isA<MatchViewLoaded>());
      expect((state as MatchViewLoaded).lastRejection, 'Not your turn');
    });

    test('submitMove before loadMatch is a no-op', () async {
      final repo = FakeMatchRepository();
      final controller = _buildController(repo);

      await controller.submitMove({'cell': 0});

      expect(repo.submittedPayloads, isEmpty);
      expect(controller.state, isA<MatchViewLoading>());
    });

    test('loadMatch surfaces a failure as MatchViewError', () async {
      final repo = _ThrowingMatchRepository();
      final controller = _buildController(repo);

      await controller.loadMatch('match-1');

      expect(controller.state, isA<MatchViewError>());
    });
  });
}

class _ThrowingMatchRepository extends FakeMatchRepository {
  @override
  Future<MatchInfo> getMatch(String matchId) async {
    throw Exception('boom');
  }
}
