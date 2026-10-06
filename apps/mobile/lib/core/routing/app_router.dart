import 'package:go_router/go_router.dart';

import '../auth/auth_controller.dart';
import '../auth/auth_state.dart';
import '../challenges/challenges_controller.dart';
import '../di/service_locator.dart';
import '../disputes/disputes_controller.dart';
import '../games/games_controller.dart';
import '../match/match_controller.dart';
import '../matchmaking/matchmaking_controller.dart';
import '../wallet/wallet_controller.dart';
import '../../features/auth/account_screen.dart';
import '../../features/auth/login_screen.dart';
import '../../features/auth/register_screen.dart';
import '../../features/auth/welcome_screen.dart';
import '../../features/disputes/disputes_screen.dart';
import '../../features/games/game_lobby_screen.dart';
import '../../features/games/games_catalog_screen.dart';
import '../../features/games/match_screen.dart';
import '../../features/wallet/deposit_screen.dart';
import '../../features/wallet/wallet_screen.dart';
import '../../features/wallet/withdraw_screen.dart';

const _publicRoutes = {'/', '/login', '/register'};

/// Routing/navigation foundation. `redirect` re-runs whenever
/// [authController] notifies (it's a [ChangeNotifier]), via
/// `refreshListenable` — so logging in/out automatically moves the user
/// between the public (welcome/login/register) and authenticated areas
/// without each screen having to navigate manually. `/wallet`, `/games`,
/// and `/matches` and their sub-routes need no extra redirect logic —
/// they're simply not in `_publicRoutes`, so the existing "anything else
/// requires auth" rule already protects them.
///
/// `MatchController` is the one controller resolved via the service
/// locator directly inside a route builder rather than threaded through
/// this function's parameters: it's registered as a factory (a fresh
/// instance per match, since each match has its own id/subscriptions —
/// see `core/di/service_locator.dart`), so there's no single shared
/// instance to pass in the way `authController`/`walletController` are.
/// `MatchScreen` itself still receives it via an explicit constructor
/// parameter, same as every other screen.
GoRouter buildAppRouter(
  AuthController authController,
  WalletController walletController,
  GamesController gamesController,
  MatchmakingController matchmakingController,
  ChallengesController challengesController,
  DisputesController disputesController,
) {
  return GoRouter(
    initialLocation: '/',
    refreshListenable: authController,
    redirect: (context, state) {
      final authState = authController.state;
      final goingToPublicRoute = _publicRoutes.contains(state.matchedLocation);

      if (authState is AuthUnknown) {
        // Still restoring a persisted session — don't redirect yet.
        return null;
      }
      if (authState is AuthAuthenticated && goingToPublicRoute) {
        return '/account';
      }
      if (authState is AuthUnauthenticated && !goingToPublicRoute) {
        return '/';
      }
      return null;
    },
    routes: [
      GoRoute(path: '/', builder: (context, state) => const WelcomeScreen()),
      GoRoute(
        path: '/login',
        builder: (context, state) =>
            LoginScreen(authController: authController),
      ),
      GoRoute(
        path: '/register',
        builder: (context, state) =>
            RegisterScreen(authController: authController),
      ),
      GoRoute(
        path: '/account',
        builder: (context, state) =>
            AccountScreen(authController: authController),
      ),
      GoRoute(
        path: '/wallet',
        builder: (context, state) =>
            WalletScreen(walletController: walletController),
      ),
      GoRoute(
        path: '/wallet/deposit',
        builder: (context, state) =>
            DepositScreen(walletController: walletController),
      ),
      GoRoute(
        path: '/wallet/withdraw',
        builder: (context, state) =>
            WithdrawScreen(walletController: walletController),
      ),
      GoRoute(
        path: '/games',
        builder: (context, state) =>
            GamesCatalogScreen(gamesController: gamesController),
      ),
      GoRoute(
        path: '/games/:gameId',
        builder: (context, state) {
          final gameId = state.pathParameters['gameId']!;
          final gameName = state.uri.queryParameters['name'] ?? gameId;
          return GameLobbyScreen(
            gameId: gameId,
            gameDisplayName: gameName,
            authController: authController,
            matchmakingController: matchmakingController,
            challengesController: challengesController,
          );
        },
      ),
      GoRoute(
        path: '/matches/:matchId',
        builder: (context, state) {
          final matchId = state.pathParameters['matchId']!;
          return MatchScreen(
            matchId: matchId,
            authController: authController,
            matchController: sl<MatchController>(),
            walletController: walletController,
            disputesController: disputesController,
          );
        },
      ),
      GoRoute(
        path: '/disputes',
        builder: (context, state) =>
            DisputesScreen(disputesController: disputesController),
      ),
    ],
  );
}
