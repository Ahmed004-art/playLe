import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/app.dart';
import 'package:playle_mobile/core/di/service_locator.dart';

void main() {
  setUp(() async {
    await sl.reset();
    await setupServiceLocator();
  });

  testWidgets('PlayLeApp boots and shows the foundation screen', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const PlayLeApp());
    await tester.pumpAndSettle();

    expect(find.text('PlayLe'), findsOneWidget);
    expect(find.text('Phase 1 — Foundation build'), findsOneWidget);
  });
}
