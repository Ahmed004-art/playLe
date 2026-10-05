import 'app_user.dart';

/// The app's current authentication state.
sealed class AuthState {
  const AuthState();
}

/// Initial state while a persisted session is still being restored on app
/// start. The router should show a splash/loading UI, not redirect yet.
class AuthUnknown extends AuthState {
  const AuthUnknown();
}

class AuthAuthenticated extends AuthState {
  const AuthAuthenticated(this.user);

  final AppUser user;
}

class AuthUnauthenticated extends AuthState {
  const AuthUnauthenticated();
}
