import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/responsible_gaming/responsible_gaming_controller.dart';
import 'package:playle_mobile/core/responsible_gaming/responsible_gaming_models.dart';
import 'package:playle_mobile/features/auth/responsible_gaming_screen.dart';

import '../../core/responsible_gaming/fake_responsible_gaming_repository.dart';

Widget _wrap(ResponsibleGamingController controller) {
  return MaterialApp(home: ResponsibleGamingScreen(controller: controller));
}

/// The screen's `ListView` only mounts children near the viewport, so
/// content below the fold (usage summaries, stake/loss limit sections,
/// their amount fields) isn't in the widget tree until scrolled into
/// view, even after [WidgetTester.pumpAndSettle].
Future<void> _scrollToBottom(WidgetTester tester) async {
  await tester.drag(find.byType(ListView), const Offset(0, -4000));
  await tester.pumpAndSettle();
}

RestrictionInfo _limit(String type, String limitMinor) => RestrictionInfo(
  id: 'r-$type',
  type: type,
  status: 'ACTIVE',
  config: {'limitMinor': limitMinor},
  startsAt: DateTime.now(),
  createdAt: DateTime.now(),
);

void main() {
  group('ResponsibleGamingScreen', () {
    testWidgets('shows a loading indicator, then the loaded content', (
      tester,
    ) async {
      final controller = ResponsibleGamingController(
        FakeResponsibleGamingRepository(),
      );
      await tester.pumpWidget(_wrap(controller));
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      await tester.pumpAndSettle();
      expect(find.text('No active restrictions.'), findsOneWidget);
      expect(find.text('Self-exclude permanently'), findsOneWidget);
    });

    testWidgets('shows a retry button on load error, which retries', (
      tester,
    ) async {
      final repo = FakeResponsibleGamingRepository()
        ..nextError = const NetworkException('offline');
      final controller = ResponsibleGamingController(repo);
      await tester.pumpWidget(_wrap(controller));
      await tester.pumpAndSettle();

      expect(find.text('Retry'), findsOneWidget);

      repo.nextError = null;
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();

      expect(find.text('No active restrictions.'), findsOneWidget);
    });

    testWidgets(
      'shows a usage summary once a limit is configured, and hides it otherwise',
      (tester) async {
        final repo = FakeResponsibleGamingRepository()
          ..restrictionsToReturn = [_limit('DEPOSIT_LIMIT', '10000')]
          ..usageToReturn = const UsageInfo(
            windowHours: 24,
            stakeHeldMinor: '0',
            lossMinor: '0',
            depositedMinor: '4000',
          );
        final controller = ResponsibleGamingController(repo);
        await tester.pumpWidget(_wrap(controller));
        await tester.pumpAndSettle();
        await _scrollToBottom(tester);

        expect(
          find.textContaining('Used Le 40.00 of your Le 100.00 limit'),
          findsOneWidget,
        );
        // No STAKE_LIMIT/LOSS_LIMIT configured — no usage line for those.
        expect(find.textContaining('of your'), findsOneWidget);
      },
    );

    testWidgets('highlights the usage summary once the limit is reached', (
      tester,
    ) async {
      final repo = FakeResponsibleGamingRepository()
        ..restrictionsToReturn = [_limit('LOSS_LIMIT', '1000')]
        ..usageToReturn = const UsageInfo(
          windowHours: 24,
          stakeHeldMinor: '0',
          lossMinor: '1000',
          depositedMinor: '0',
        );
      final controller = ResponsibleGamingController(repo);
      await tester.pumpWidget(_wrap(controller));
      await tester.pumpAndSettle();
      await _scrollToBottom(tester);

      final text = tester.widget<Text>(
        find.textContaining('Used Le 10.00 of your Le 10.00 limit'),
      );
      expect((text.style?.color), isNotNull);
    });

    testWidgets('shows the self-exclusion banner once self-excluded', (
      tester,
    ) async {
      final repo = FakeResponsibleGamingRepository()
        ..restrictionsToReturn = [
          RestrictionInfo(
            id: 'r-se',
            type: 'SELF_EXCLUSION',
            status: 'ACTIVE',
            config: const {},
            startsAt: DateTime.now(),
            createdAt: DateTime.now(),
          ),
        ];
      final controller = ResponsibleGamingController(repo);
      await tester.pumpWidget(_wrap(controller));
      await tester.pumpAndSettle();

      expect(find.textContaining('permanently self-excluded'), findsOneWidget);
      expect(find.text('Self-exclude permanently'), findsNothing);
    });

    testWidgets(
      'self-exclusion requires typing the exact confirmation phrase',
      (tester) async {
        final repo = FakeResponsibleGamingRepository();
        final controller = ResponsibleGamingController(repo);
        await tester.pumpWidget(_wrap(controller));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Self-exclude permanently'));
        await tester.pumpAndSettle();

        expect(find.text('Permanently self-exclude?'), findsOneWidget);
        final confirmButton = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, 'Permanently exclude myself'),
        );
        expect(confirmButton.onPressed, isNull);

        final dialogTextField = find.descendant(
          of: find.byType(AlertDialog),
          matching: find.byType(TextField),
        );

        await tester.enterText(dialogTextField, 'wrong phrase');
        await tester.pump();
        expect(
          tester
              .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'Permanently exclude myself'),
              )
              .onPressed,
          isNull,
        );

        await tester.enterText(dialogTextField, 'EXCLUDE ME');
        await tester.pump();
        await tester.tap(
          find.widgetWithText(FilledButton, 'Permanently exclude myself'),
        );
        await tester.pumpAndSettle();

        expect(repo.selfExcludeCallCount, 1);
        expect(
          find.textContaining('permanently self-excluded'),
          findsOneWidget,
        );
      },
    );

    testWidgets('tapping a cooling-off preset starts that duration', (
      tester,
    ) async {
      final repo = FakeResponsibleGamingRepository();
      final controller = ResponsibleGamingController(repo);
      await tester.pumpWidget(_wrap(controller));
      await tester.pumpAndSettle();

      await tester.tap(find.text('1 week'));
      await tester.pumpAndSettle();

      expect(repo.coolingOffCallsMinutes, [7 * 24 * 60]);
    });

    testWidgets('setting a deposit limit forwards the minor-unit amount', (
      tester,
    ) async {
      final repo = FakeResponsibleGamingRepository();
      final controller = ResponsibleGamingController(repo);
      await tester.pumpWidget(_wrap(controller));
      await tester.pumpAndSettle();
      await tester.drag(find.byType(ListView), const Offset(0, -400));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.widgetWithText(TextField, 'Amount (Le)').first,
        '50',
      );
      await tester.pump();
      await tester.tap(find.text('Set deposit limit'));
      await tester.pumpAndSettle();

      expect(repo.setDepositLimitCalls, ['5000']);
    });
  });
}
