import 'package:flutter/foundation.dart';

import '../logging/app_logger.dart';
import 'auth_repository.dart';
import 'auth_state.dart';

/// Owns the app's authentication state. Screens read [state] (typically via
/// `ListenableBuilder(listenable: sl<AuthController>(), ...)`, since this
/// extends [ChangeNotifier]) and call [register]/[login]/[logout] — they
/// never talk to [AuthRepository] directly.
///
/// Errors are never swallowed: every method that can fail rethrows the
/// underlying [AppException] after updating state as appropriate, so the
/// caller (a form screen) can show the real error to the user.
class AuthController extends ChangeNotifier {
  AuthController(this._repository);

  final AuthRepository _repository;

  AuthState _state = const AuthUnknown();
  AuthState get state => _state;

  bool get isAuthenticated => _state is AuthAuthenticated;

  /// Call once at app start to restore a persisted session, if any.
  Future<void> bootstrap() async {
    try {
      final user = await _repository.loadSession();
      _setState(
        user != null ? AuthAuthenticated(user) : const AuthUnauthenticated(),
      );
    } catch (e) {
      AppLogger.instance.warning('Failed to restore session: $e');
      _setState(const AuthUnauthenticated());
    }
  }

  Future<void> register({
    required String email,
    required String username,
    required String password,
    required DateTime dateOfBirth,
    String? phoneNumber,
  }) async {
    final user = await _repository.register(
      email: email,
      username: username,
      password: password,
      dateOfBirth: dateOfBirth,
      phoneNumber: phoneNumber,
    );
    _setState(AuthAuthenticated(user));
  }

  /// Logs in, or — when the account has MFA enrolled — pauses at
  /// [AuthMfaChallenge] instead. The caller doesn't need to branch on the
  /// outcome itself: the router's redirect (driven by this controller's
  /// state) takes the user to the right screen either way.
  Future<void> login({
    required String identifier,
    required String password,
  }) async {
    final result = await _repository.login(
      identifier: identifier,
      password: password,
    );
    switch (result) {
      case LoginSuccess(user: final user):
        _setState(AuthAuthenticated(user));
      case LoginMfaRequired(mfaChallengeToken: final token):
        _setState(AuthMfaChallenge(token));
    }
  }

  /// Completes a login paused at [AuthMfaChallenge]. Throws [StateError]
  /// if called from any other state — the caller (the MFA-challenge
  /// screen) only exists while that state is current.
  Future<void> verifyMfaLogin(String code) async {
    final state = _state;
    if (state is! AuthMfaChallenge) {
      throw StateError('No MFA challenge is in progress');
    }
    final user = await _repository.verifyMfaLogin(
      mfaChallengeToken: state.mfaChallengeToken,
      code: code,
    );
    _setState(AuthAuthenticated(user));
  }

  /// Abandons an in-progress MFA challenge (e.g. the user taps "Cancel"),
  /// returning to the logged-out state.
  void cancelMfaChallenge() {
    if (_state is AuthMfaChallenge) {
      _setState(const AuthUnauthenticated());
    }
  }

  Future<void> logout() async {
    try {
      await _repository.logout();
    } finally {
      // Always land logged-out locally, even if the server call failed.
      _setState(const AuthUnauthenticated());
    }
  }

  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    await _repository.changePassword(
      currentPassword: currentPassword,
      newPassword: newPassword,
    );
    // The API revokes all sessions on password change — reflect that locally.
    _setState(const AuthUnauthenticated());
  }

  /// Requests a password reset code for [identifier] (email or phone).
  /// Returns the server's generic message verbatim — the UI must display
  /// it as-is rather than composing its own, so it can never imply
  /// whether the identifier matched an account.
  Future<String> requestPasswordReset(String identifier) {
    return _repository.requestPasswordReset(identifier);
  }

  /// Completes a password reset. Does not change [state] itself — the
  /// account's sessions (including, if any, this device's) are revoked
  /// server-side, so the caller sends the user back through [login]
  /// rather than treating this as a sign-in.
  Future<void> confirmPasswordReset({
    required String token,
    required String newPassword,
  }) {
    return _repository.confirmPasswordReset(
      token: token,
      newPassword: newPassword,
    );
  }

  /// Sends a one-time verification code for `'EMAIL'`/`'SMS'`.
  Future<void> requestVerification(String channel) {
    return _repository.requestVerification(channel);
  }

  /// Confirms a verification code, then refreshes the current user so
  /// `emailVerifiedAt`/`phoneVerifiedAt` reflect the change immediately.
  Future<void> confirmVerification({
    required String channel,
    required String code,
  }) async {
    await _repository.confirmVerification(channel: channel, code: code);
    await refreshUser();
  }

  /// Re-fetches the current user without changing which [AuthState]
  /// subtype is active. No-ops if not currently authenticated.
  Future<void> refreshUser() async {
    final state = _state;
    if (state is! AuthAuthenticated) return;
    final user = await _repository.fetchCurrentUser();
    _setState(AuthAuthenticated(user));
  }

  void _setState(AuthState next) {
    _state = next;
    notifyListeners();
  }
}
