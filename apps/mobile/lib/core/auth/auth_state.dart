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

/// `/auth/login` paused for an MFA challenge instead of issuing tokens
/// (the account has TOTP enrolled — see ADR-020). The router redirects
/// here until [AuthController.verifyMfaLogin] succeeds (→
/// [AuthAuthenticated]) or [AuthController.cancelMfaChallenge] is called
/// (→ [AuthUnauthenticated]).
class AuthMfaChallenge extends AuthState {
  const AuthMfaChallenge(this.mfaChallengeToken);

  final String mfaChallengeToken;
}
