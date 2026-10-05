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

  Future<void> login({
    required String identifier,
    required String password,
  }) async {
    final user = await _repository.login(
      identifier: identifier,
      password: password,
    );
    _setState(AuthAuthenticated(user));
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

  void _setState(AuthState next) {
    _state = next;
    notifyListeners();
  }
}
