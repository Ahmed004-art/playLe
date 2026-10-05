import 'package:go_router/go_router.dart';

import '../auth/auth_controller.dart';
import '../auth/auth_state.dart';
import '../../features/auth/account_screen.dart';
import '../../features/auth/login_screen.dart';
import '../../features/auth/register_screen.dart';
import '../../features/auth/welcome_screen.dart';

const _publicRoutes = {'/', '/login', '/register'};

/// Routing/navigation foundation. `redirect` re-runs whenever
/// [authController] notifies (it's a [ChangeNotifier]), via
/// `refreshListenable` — so logging in/out automatically moves the user
/// between the public (welcome/login/register) and authenticated areas
/// without each screen having to navigate manually.
GoRouter buildAppRouter(AuthController authController) {
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
    ],
  );
}
