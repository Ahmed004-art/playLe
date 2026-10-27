import '../errors/app_exception.dart';
import '../logging/app_logger.dart';
import '../network/api_client.dart';
import '../network/session_refresh.dart';
import '../storage/secure_storage.dart';
import 'auth_repository.dart';

/// Renews an expired session in the background (Phase 13).
///
/// The access token lives for 15 minutes; before this, the app refreshed it
/// only when restoring a saved session at start-up, so a session used for
/// longer than that failed every request with 401 until the app was
/// restarted. `ApiClient` now calls [refresh] when a request fails with 401
/// and retries that request once with the new token.
///
/// **One refresh at a time.** The API rotates the refresh token on every use
/// and treats presenting an already-used one as theft, revoking the whole
/// session. If several requests expire together and each refreshed, the
/// second would present a token the first had just used and sign the user out.
/// So concurrent callers share one in-flight refresh and all get its result.
///
/// Only a definitive refusal (400/401/403 from `/auth/refresh`, or no refresh
/// token at all) ends the session: tokens are cleared and [onSessionLost] is
/// called so the app returns to the sign-in flow. A transient failure (no
/// connection, a 5xx, an unreadable reply) clears nothing and reports
/// [SessionRefreshResult.unavailable].
class SessionRefresher {
  SessionRefresher({
    required this.apiClient,
    required this.secureStorage,
    required this.onSessionLost,
  });

  final ApiClient apiClient;
  final SecureStorage secureStorage;

  /// Called after the local tokens were cleared. A later request that finds no
  /// tokens calls it again, so it must be idempotent (`AuthController.
  /// sessionExpired` ignores it once signed out).
  final void Function() onSessionLost;

  Future<SessionRefreshResult>? _inFlight;

  Future<SessionRefreshResult> refresh() {
    final running = _inFlight;
    if (running != null) {
      return running;
    }
    final started = _refreshOnce().whenComplete(() => _inFlight = null);
    _inFlight = started;
    return started;
  }

  Future<SessionRefreshResult> _refreshOnce() async {
    final refreshToken = await secureStorage.read(AuthStorageKeys.refreshToken);
    if (refreshToken == null) {
      return _sessionLost();
    }

    try {
      final response = await apiClient.post<Map<String, dynamic>>(
        '/auth/refresh',
        data: {'refreshToken': refreshToken},
      );
      final body = response.data;
      final access = body?['accessToken'];
      final refresh = body?['refreshToken'];
      if (access is! String || refresh is! String) {
        AppLogger.instance.warning(
          'Session refresh returned an unusable reply',
        );
        return SessionRefreshResult.unavailable;
      }
      // Two writes cannot be made atomic, so order them for the failure that
      // matters: the server has already rotated the refresh token, and the old
      // one is now a reuse trap. Store the new refresh token first; if the app
      // dies before the access token is stored, the stale access token just
      // 401s and the next refresh uses the valid new refresh token.
      await secureStorage.write(AuthStorageKeys.refreshToken, refresh);
      await secureStorage.write(AuthStorageKeys.accessToken, access);
      return SessionRefreshResult.refreshed;
    } on NetworkException catch (e) {
      final code = e.statusCode;
      if (code == 400 || code == 401 || code == 403) {
        return _sessionLost();
      }
      AppLogger.instance.warning('Session refresh unavailable: ${e.message}');
      return SessionRefreshResult.unavailable;
    }
  }

  Future<SessionRefreshResult> _sessionLost() async {
    await secureStorage.delete(AuthStorageKeys.accessToken);
    await secureStorage.delete(AuthStorageKeys.refreshToken);
    onSessionLost();
    return SessionRefreshResult.rejected;
  }
}
