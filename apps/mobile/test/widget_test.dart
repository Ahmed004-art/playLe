import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/app.dart';
import 'package:playle_mobile/core/di/service_locator.dart';

void main() {
  setUp(() async {
    await sl.reset();
    await setupServiceLocator();
    // Deliberately not calling AuthController.bootstrap() here — state
    // stays AuthUnknown, which the router treats as "don't redirect yet",
    // so the app renders the welcome screen at its initial route.
  });

  testWidgets('PlayLeApp boots and shows the welcome screen', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const PlayLeApp());
    await tester.pumpAndSettle();

    expect(find.text('PlayLe'), findsOneWidget);
    expect(find.text('Create account'), findsOneWidget);
    expect(find.text('Log in'), findsOneWidget);
  });
}
