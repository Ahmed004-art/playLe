import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/disputes/disputes_controller.dart';
import 'package:playle_mobile/core/disputes/disputes_state.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';

import 'fake_disputes_repository.dart';

void main() {
  group('DisputesController', () {
    test('starts in DisputesLoading before refresh is called', () {
      final controller = DisputesController(FakeDisputesRepository());
      expect(controller.state, isA<DisputesLoading>());
    });

    test('refresh loads the dispute list', () async {
      final repo = FakeDisputesRepository()..disputesToReturn = [testDispute];
      final controller = DisputesController(repo);

      await controller.refresh();

      final state = controller.state;
      expect(state, isA<DisputesLoaded>());
      expect((state as DisputesLoaded).disputes, [testDispute]);
    });

    test('refresh surfaces an error as DisputesLoadError', () async {
      final repo = FakeDisputesRepository()
        ..nextError = const NetworkException('Server unreachable');
      final controller = DisputesController(repo);

      await controller.refresh();

      expect(controller.state, isA<DisputesLoadError>());
    });

    test(
      'create files a dispute against the given match and refreshes',
      () async {
        final repo = FakeDisputesRepository()..disputesToReturn = [testDispute];
        final controller = DisputesController(repo);

        final result = await controller.create(
          'match-1',
          'Opponent disconnected and never came back.',
        );

        expect(result.id, testDispute.id);
        expect(repo.lastCreatedMatchId, 'match-1');
        expect(
          repo.lastCreatedReason,
          'Opponent disconnected and never came back.',
        );
        expect(controller.state, isA<DisputesLoaded>());
      },
    );

    test(
      'create rethrows the repository\'s error without swallowing it',
      () async {
        final repo = FakeDisputesRepository()
          ..nextError = const NetworkException(
            'Reason must be at least 10 characters',
          );
        final controller = DisputesController(repo);

        await expectLater(
          controller.create('match-1', 'short'),
          throwsA(isA<NetworkException>()),
        );
      },
    );
  });
}
