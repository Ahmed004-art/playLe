import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:playle_mobile/core/auth/app_user.dart';
import 'package:playle_mobile/core/auth/auth_controller.dart';
import 'package:playle_mobile/core/theme/app_theme.dart';
import 'package:playle_mobile/features/auth/account_screen.dart';
import 'package:playle_mobile/features/social/friends_screen.dart';
import 'package:playle_mobile/features/social/match_history_screen.dart';
import 'package:playle_mobile/features/social/player_profile_screen.dart';

import '../../core/auth/fake_auth_repository.dart';
import '../../core/games/fake_games_repository.dart';
import '../../core/social/fake_social_repository.dart';
import '../../core/social/friends_harness.dart';

/// The signed-in player used across the social widget tests. Its id is a
/// real UUID (see `fake_social_repository.dart`), unlike `testUser`.
const testPlayer = AppUser(
  id: myId,
  email: 'player@example.com',
  username: 'playerone',
  role: 'USER',
  status: 'ACTIVE',
);

class SignedIn {
  SignedIn(this.controller, this.repository);

  final AuthController controller;
  final FakeAuthRepository repository;
}

Future<SignedIn> signedIn({AppUser user = testPlayer}) async {
  final repository = FakeAuthRepository()..sessionToRestore = user;
  final controller = AuthController(repository);
  await controller.bootstrap();
  return SignedIn(controller, repository);
}

/// A router with just the routes this PR adds plus the account hub, so
/// navigation to and back from the profile and history screens is exercised
/// through real `go_router` navigation without the whole app's controllers.
GoRouter buildSocialRouter({
  required AuthController auth,
  required FakeSocialRepository social,
  FakeGamesRepository? games,
  FriendsHarness? friends,
  String initialLocation = '/account',
}) {
  final friendsHarness = friends ?? FriendsHarness(social: social);
  return GoRouter(
    initialLocation: initialLocation,
    routes: [
      GoRoute(
        path: '/account',
        builder: (context, state) => AccountScreen(authController: auth),
      ),
      GoRoute(
        path: '/friends',
        builder: (context, state) => FriendsScreen(
          authController: auth,
          createController: friendsHarness.create,
        ),
      ),
      GoRoute(
        path: '/players/:userId',
        builder: (context, state) {
          final userId = state.pathParameters['userId']!;
          return PlayerProfileScreen(
            key: ValueKey(userId),
            userId: userId,
            repository: social,
            authController: auth,
          );
        },
      ),
      GoRoute(
        path: '/history',
        builder: (context, state) => MatchHistoryScreen(
          repository: social,
          gamesRepository: games ?? FakeGamesRepository(),
          authController: auth,
        ),
      ),
    ],
  );
}

Widget socialApp(GoRouter router) {
  return MaterialApp.router(theme: AppTheme.dark, routerConfig: router);
}

/// Tall enough that every row of a list is built, so tests can find them.
void useTallScreen(WidgetTester tester, {double width = 800}) {
  tester.view.physicalSize = Size(width, 3000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}
