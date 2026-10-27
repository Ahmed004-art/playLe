import 'package:flutter/widgets.dart' show ValueKey;
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
import '../../features/auth/forgot_password_screen.dart';
import '../../features/auth/login_screen.dart';
import '../../features/auth/mfa_challenge_screen.dart';
import '../../features/auth/mfa_screen.dart';
import '../../features/auth/register_screen.dart';
import '../../features/auth/responsible_gaming_screen.dart';
import '../../features/auth/sessions_screen.dart';
import '../../features/auth/welcome_screen.dart';
import '../../features/disputes/disputes_screen.dart';
import '../../features/games/game_lobby_screen.dart';
import '../../features/games/games_catalog_screen.dart';
import '../../features/games/match_screen.dart';
import '../../features/social/friends_screen.dart';
import '../../features/social/match_history_screen.dart';
import '../../features/social/player_profile_screen.dart';
import '../../features/wallet/deposit_screen.dart';
import '../../features/wallet/wallet_screen.dart';
import '../../features/wallet/withdraw_screen.dart';
import '../mfa/mfa_controller.dart';
import '../games/games_repository.dart';
import '../responsible_gaming/responsible_gaming_controller.dart';
import '../sessions/sessions_controller.dart';
import '../network/websocket_client.dart';
import '../realtime/realtime_connection_manager.dart';
import '../social/friends_hub_controller.dart';
import '../social/social_repository.dart';

const _publicRoutes = {'/', '/login', '/register', '/password-reset'};

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
      final location = state.matchedLocation;
      final goingToPublicRoute = _publicRoutes.contains(location);

      if (authState is AuthUnknown) {
        // Still restoring a persisted session — don't redirect yet.
        return null;
      }
      // `/auth/login` paused for an MFA challenge — the only screen
      // reachable in this state is `/mfa-challenge` itself.
      if (authState is AuthMfaChallenge) {
        return location == '/mfa-challenge' ? null : '/mfa-challenge';
      }
      if (authState is AuthAuthenticated &&
          (goingToPublicRoute || location == '/mfa-challenge')) {
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
        path: '/password-reset',
        builder: (context, state) =>
            ForgotPasswordScreen(authController: authController),
      ),
      GoRoute(
        path: '/mfa-challenge',
        builder: (context, state) =>
            MfaChallengeScreen(authController: authController),
      ),
      GoRoute(
        path: '/account',
        builder: (context, state) =>
            AccountScreen(authController: authController),
      ),
      GoRoute(
        path: '/account/mfa',
        builder: (context, state) =>
            MfaScreen(mfaController: sl<MfaController>()),
      ),
      GoRoute(
        path: '/account/sessions',
        builder: (context, state) => SessionsScreen(
          sessionsController: sl<SessionsController>(),
          authController: authController,
        ),
      ),
      GoRoute(
        path: '/account/responsible-gaming',
        builder: (context, state) => ResponsibleGamingScreen(
          controller: sl<ResponsibleGamingController>(),
        ),
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
      // Friends, friend requests and blocked players (Phase 12 PR 5). The
      // screen builds its own controller once, for the signed-in player, and
      // disposes it (and its realtime listeners) with the screen.
      GoRoute(
        path: '/friends',
        builder: (context, state) => FriendsScreen(
          authController: authController,
          createController: (myUserId) => FriendsHubController(
            social: sl<SocialRepository>(),
            games: sl<GamesRepository>(),
            createChallenge: challengesController.challengeByUserId,
            webSocketClient: sl<WebSocketClient>(),
            realtimeConnectionManager: sl<RealtimeConnectionManager>(),
            myUserId: myUserId,
          ),
        ),
      ),
      // Public player profiles (Phase 12). The id comes from the route, so a
      // stale or hand-edited link is handled by the screen ("Player not
      // found"), not trusted. `ValueKey(userId)` gives every profile its own
      // screen state, so going from one profile to another never reuses the
      // previous player's loaded data.
      GoRoute(
        path: '/players/:userId',
        builder: (context, state) {
          final userId = state.pathParameters['userId']!;
          return PlayerProfileScreen(
            key: ValueKey(userId),
            userId: userId,
            repository: sl<SocialRepository>(),
            authController: authController,
          );
        },
      ),
      // `/history`, not `/matches/history`: `/matches/:matchId` would claim it.
      GoRoute(
        path: '/history',
        builder: (context, state) => MatchHistoryScreen(
          repository: sl<SocialRepository>(),
          gamesRepository: sl<GamesRepository>(),
          authController: authController,
        ),
      ),
      GoRoute(
        path: '/disputes',
        builder: (context, state) =>
            DisputesScreen(disputesController: disputesController),
      ),
    ],
  );
}
