import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/auth/auth_controller.dart';
import 'package:playle_mobile/core/routing/app_router.dart';
import 'package:playle_mobile/core/theme/app_theme.dart';
import 'package:playle_mobile/core/wallet/wallet_controller.dart';

import '../../core/auth/fake_auth_repository.dart';
import '../../core/wallet/fake_wallet_repository.dart';

Widget buildTestApp(AuthController controller, [WalletController? wallet]) {
  return MaterialApp.router(
    theme: AppTheme.dark,
    routerConfig: buildAppRouter(
      controller,
      wallet ?? WalletController(FakeWalletRepository()),
    ),
  );
}

void main() {
  testWidgets('shows the welcome screen while unauthenticated', (tester) async {
    final controller = AuthController(FakeAuthRepository());
    await controller.bootstrap();

    await tester.pumpWidget(buildTestApp(controller));
    await tester.pumpAndSettle();

    expect(find.text('Create account'), findsOneWidget);
  });

  testWidgets('redirects an authenticated user away from /login to /account', (
    tester,
  ) async {
    final repo = FakeAuthRepository()..sessionToRestore = testUser;
    final controller = AuthController(repo);
    await controller.bootstrap();

    final router = buildAppRouter(
      controller,
      WalletController(FakeWalletRepository()),
    );
    router.go('/login');

    await tester.pumpWidget(
      MaterialApp.router(theme: AppTheme.dark, routerConfig: router),
    );
    await tester.pumpAndSettle();

    expect(find.text('@playerone'), findsOneWidget);
    expect(find.text('Log in'), findsNothing);
  });

  testWidgets(
    'redirects an unauthenticated user away from /account to the welcome screen',
    (tester) async {
      final controller = AuthController(FakeAuthRepository());
      await controller.bootstrap();

      final router = buildAppRouter(
        controller,
        WalletController(FakeWalletRepository()),
      );
      router.go('/account');

      await tester.pumpWidget(
        MaterialApp.router(theme: AppTheme.dark, routerConfig: router),
      );
      await tester.pumpAndSettle();

      expect(find.text('Create account'), findsOneWidget);
    },
  );

  testWidgets(
    'moves from welcome to account automatically when login succeeds',
    (tester) async {
      final controller = AuthController(FakeAuthRepository());
      await controller.bootstrap();

      await tester.pumpWidget(buildTestApp(controller));
      await tester.pumpAndSettle();
      expect(find.text('Create account'), findsOneWidget);

      await controller.login(
        identifier: 'player@example.com',
        password: 'Passw0rd1',
      );
      await tester.pumpAndSettle();

      expect(find.text('@playerone'), findsOneWidget);
    },
  );
}
