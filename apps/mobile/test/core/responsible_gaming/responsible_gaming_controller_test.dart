import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/responsible_gaming/responsible_gaming_controller.dart';
import 'package:playle_mobile/core/responsible_gaming/responsible_gaming_models.dart';
import 'package:playle_mobile/core/responsible_gaming/responsible_gaming_state.dart';

import 'fake_responsible_gaming_repository.dart';

void main() {
  group('ResponsibleGamingController', () {
    test('starts in ResponsibleGamingLoading before refresh is called', () {
      final controller = ResponsibleGamingController(
        FakeResponsibleGamingRepository(),
      );
      expect(controller.state, isA<ResponsibleGamingLoading>());
    });

    test('refresh loads both restrictions and current usage', () async {
      final repo = FakeResponsibleGamingRepository()
        ..usageToReturn = const UsageInfo(
          windowHours: 24,
          stakeHeldMinor: '1000',
          lossMinor: '500',
          depositedMinor: '2000',
        );
      final controller = ResponsibleGamingController(repo);

      await controller.refresh();

      final state = controller.state;
      expect(state, isA<ResponsibleGamingLoaded>());
      final loaded = state as ResponsibleGamingLoaded;
      expect(loaded.usage.stakeHeldMinor, '1000');
      expect(loaded.usage.lossMinor, '500');
      expect(loaded.usage.depositedMinor, '2000');
    });

    test('refresh surfaces an error as ResponsibleGamingLoadError', () async {
      final repo = FakeResponsibleGamingRepository()
        ..nextError = const NetworkException('Server unreachable');
      final controller = ResponsibleGamingController(repo);

      await controller.refresh();

      expect(controller.state, isA<ResponsibleGamingLoadError>());
    });

    test(
      'isSelfExcluded reflects an active SELF_EXCLUSION restriction',
      () async {
        final repo = FakeResponsibleGamingRepository();
        final controller = ResponsibleGamingController(repo);
        await controller.refresh();
        expect(
          (controller.state as ResponsibleGamingLoaded).isSelfExcluded,
          isFalse,
        );

        await controller.selfExclude();

        expect(
          (controller.state as ResponsibleGamingLoaded).isSelfExcluded,
          isTrue,
        );
        expect(repo.selfExcludeCallCount, 1);
      },
    );

    test('startCoolingOff forwards the duration and refreshes', () async {
      final repo = FakeResponsibleGamingRepository();
      final controller = ResponsibleGamingController(repo);

      await controller.startCoolingOff(60);

      expect(repo.coolingOffCallsMinutes, [60]);
      expect(controller.state, isA<ResponsibleGamingLoaded>());
    });

    test(
      'setDepositLimit/setStakeLimit/setLossLimit forward the amount and refresh',
      () async {
        final repo = FakeResponsibleGamingRepository();
        final controller = ResponsibleGamingController(repo);

        await controller.setDepositLimit('5000');
        await controller.setStakeLimit('3000');
        await controller.setLossLimit('2000');

        expect(repo.setDepositLimitCalls, ['5000']);
        expect(repo.setStakeLimitCalls, ['3000']);
        expect(repo.setLossLimitCalls, ['2000']);
      },
    );

    test(
      'selfExclude rethrows the repository error without swallowing it',
      () async {
        final repo = FakeResponsibleGamingRepository()
          ..nextError = const NetworkException('Already excluded');
        final controller = ResponsibleGamingController(repo);

        await expectLater(
          controller.selfExclude(),
          throwsA(isA<AppException>()),
        );
      },
    );
  });
}
