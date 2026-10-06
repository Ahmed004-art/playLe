import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/disputes/dispute_models.dart';
import 'package:playle_mobile/core/disputes/disputes_controller.dart';
import 'package:playle_mobile/features/disputes/disputes_screen.dart';

import '../../core/disputes/fake_disputes_repository.dart';

Widget _wrap(DisputesController controller) {
  return MaterialApp(home: DisputesScreen(disputesController: controller));
}

void main() {
  group('DisputesScreen', () {
    testWidgets('shows an empty state when there are no disputes', (
      tester,
    ) async {
      final controller = DisputesController(FakeDisputesRepository());

      await tester.pumpWidget(_wrap(controller));
      await tester.pumpAndSettle();

      expect(find.text("You haven't filed any disputes."), findsOneWidget);
    });

    testWidgets('lists the user\'s own disputes with their status', (
      tester,
    ) async {
      final repo = FakeDisputesRepository()..disputesToReturn = [testDispute];
      final controller = DisputesController(repo);

      await tester.pumpWidget(_wrap(controller));
      await tester.pumpAndSettle();

      expect(find.text(testDispute.reason), findsOneWidget);
      expect(find.text('OPEN'), findsOneWidget);
    });

    testWidgets('shows the resolution text once a dispute is resolved', (
      tester,
    ) async {
      final resolved = DisputeInfo(
        id: testDispute.id,
        matchId: testDispute.matchId,
        raisedByUserId: testDispute.raisedByUserId,
        reason: testDispute.reason,
        status: 'RESOLVED',
        resolution: 'Reviewed — no action needed.',
        resolvedByAdminId: 'admin-1',
        createdAt: testDispute.createdAt,
        resolvedAt: DateTime.utc(2026, 1, 2),
      );
      final repo = FakeDisputesRepository()..disputesToReturn = [resolved];
      final controller = DisputesController(repo);

      await tester.pumpWidget(_wrap(controller));
      await tester.pumpAndSettle();

      expect(
        find.textContaining('Reviewed — no action needed.'),
        findsOneWidget,
      );
    });
  });
}
