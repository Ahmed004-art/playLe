import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/challenges/challenges_controller.dart';
import 'package:playle_mobile/core/challenges/challenges_state.dart';
import 'package:playle_mobile/core/config/app_config.dart';
import 'package:playle_mobile/core/network/websocket_client.dart';
import 'package:playle_mobile/core/realtime/realtime_connection_manager.dart';

import '../realtime/fake_secure_storage.dart';
import 'fake_challenges_repository.dart';

const _testConfig = AppConfig(
  environment: Environment.development,
  apiBaseUrl: 'http://localhost:0/api/v1',
  socketUrl: 'http://localhost:0',
);

RealtimeConnectionManager _fakeRealtime() => RealtimeConnectionManager(
  webSocketClient: WebSocketClient(config: _testConfig),
  secureStorage: FakeSecureStorage(),
);

ChallengesController _buildController(FakeChallengesRepository repo) =>
    ChallengesController(
      repo,
      WebSocketClient(config: _testConfig),
      _fakeRealtime(),
    );

void main() {
  group('ChallengesController', () {
    test('starts in ChallengesLoading before refresh is called', () {
      final controller = _buildController(FakeChallengesRepository());
      expect(controller.state, isA<ChallengesLoading>());
    });

    test('refresh loads the challenge list', () async {
      final repo = FakeChallengesRepository()
        ..challengesToReturn = [testChallenge];
      final controller = _buildController(repo);

      await controller.refresh();

      final state = controller.state;
      expect(state, isA<ChallengesLoaded>());
      expect((state as ChallengesLoaded).challenges, [testChallenge]);
    });

    test(
      'challengeByUsername resolves the username then creates a challenge',
      () async {
        final repo = FakeChallengesRepository()..userIdToReturn = 'user-42';
        final controller = _buildController(repo);

        final result = await controller.challengeByUsername(
          'tic_tac_toe',
          'opponent',
        );

        expect(result.id, testChallenge.id);
      },
    );

    test('accept refreshes the list afterward', () async {
      final repo = FakeChallengesRepository()
        ..challengesToReturn = [testChallenge];
      final controller = _buildController(repo);
      await controller.refresh();

      await controller.accept(testChallenge.id);

      expect(controller.state, isA<ChallengesLoaded>());
    });

    test('decline refreshes the list afterward', () async {
      final repo = FakeChallengesRepository()
        ..challengesToReturn = [testChallenge];
      final controller = _buildController(repo);
      await controller.refresh();

      await controller.decline(testChallenge.id);

      expect(controller.state, isA<ChallengesLoaded>());
    });

    test('cancel refreshes the list afterward', () async {
      final repo = FakeChallengesRepository()
        ..challengesToReturn = [testChallenge];
      final controller = _buildController(repo);
      await controller.refresh();

      await controller.cancel(testChallenge.id);

      expect(controller.state, isA<ChallengesLoaded>());
    });

    test('isIncomingFor correctly identifies the opponent', () {
      expect(testChallenge.isIncomingFor('user-2'), isTrue);
      expect(testChallenge.isIncomingFor('user-1'), isFalse);
    });
  });
}
