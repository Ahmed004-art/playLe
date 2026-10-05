import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:playle_mobile/core/auth/auth_controller.dart';
import 'package:playle_mobile/core/challenges/challenges_controller.dart';
import 'package:playle_mobile/core/config/app_config.dart';
import 'package:playle_mobile/core/games/games_controller.dart';
import 'package:playle_mobile/core/matchmaking/matchmaking_controller.dart';
import 'package:playle_mobile/core/network/websocket_client.dart';
import 'package:playle_mobile/core/realtime/realtime_connection_manager.dart';
import 'package:playle_mobile/core/routing/app_router.dart';
import 'package:playle_mobile/core/theme/app_theme.dart';
import 'package:playle_mobile/core/wallet/wallet_controller.dart';

import '../../core/auth/fake_auth_repository.dart';
import '../../core/challenges/fake_challenges_repository.dart';
import '../../core/games/fake_games_repository.dart';
import '../../core/matchmaking/fake_matchmaking_repository.dart';
import '../../core/realtime/fake_secure_storage.dart';
import '../../core/wallet/fake_wallet_repository.dart';

/// Builds a router wired with fakes for every non-auth/wallet controller
/// `buildAppRouter` now also needs. `RealtimeConnectionManager`'s
/// `FakeSecureStorage` never has a token preset, so `connect()` always
/// no-ops — no real socket connection is ever attempted in these tests.
GoRouter _buildTestRouter(AuthController controller) {
  const config = AppConfig(
    environment: Environment.development,
    apiBaseUrl: 'http://localhost:0/api/v1',
    socketUrl: 'http://localhost:0',
  );
  final webSocketClient = WebSocketClient(config: config);
  final realtime = RealtimeConnectionManager(
    webSocketClient: webSocketClient,
    secureStorage: FakeSecureStorage(),
  );

  return buildAppRouter(
    controller,
    WalletController(FakeWalletRepository()),
    GamesController(FakeGamesRepository()),
    MatchmakingController(
      FakeMatchmakingRepository(),
      webSocketClient,
      realtime,
    ),
    ChallengesController(FakeChallengesRepository(), webSocketClient, realtime),
  );
}

Widget buildTestApp(AuthController controller) {
  return MaterialApp.router(
    theme: AppTheme.dark,
    routerConfig: _buildTestRouter(controller),
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

    final router = _buildTestRouter(controller);
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

      final router = _buildTestRouter(controller);
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
