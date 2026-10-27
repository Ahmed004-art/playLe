import '../errors/app_exception.dart';
import '../network/api_client.dart';
import '../storage/secure_storage.dart';
import 'app_user.dart';

/// Storage keys for persisted session material. Centralized here (rather
/// than scattered as string literals) since both this repository and
/// `ApiClient`'s `getAccessToken` wiring (see `core/di/service_locator.dart`)
/// need to agree on them.
abstract final class AuthStorageKeys {
  static const accessToken = 'auth.access_token';
  static const refreshToken = 'auth.refresh_token';
}

/// The result of [AuthRepository.login] — either a normal successful
/// login, or a pause for an MFA challenge (mirrors the API's union
/// response: `AuthResponseDto | MfaChallengeResponseDto` — see
/// `apps/api/src/auth/auth.controller.ts`).
sealed class LoginResult {
  const LoginResult();
}

class LoginSuccess extends LoginResult {
  const LoginSuccess(this.user);

  final AppUser user;
}

class LoginMfaRequired extends LoginResult {
  const LoginMfaRequired(this.mfaChallengeToken);

  final String mfaChallengeToken;
}

/// Authentication abstraction. The UI never talks to [ApiClient] or
/// [SecureStorage] directly for auth — only through this repository (see
/// `core/auth/auth_controller.dart`), so the HTTP/storage implementation
/// can change or be swapped for a fake in tests without touching any
/// screen.
abstract class AuthRepository {
  /// Restores a session from secure storage on app start, if one exists
  /// and is still valid (refreshing once if the access token has expired).
  /// Returns null if there's no session, or it couldn't be restored.
  Future<AppUser?> loadSession();

  /// Re-fetches the current user (`GET /auth/me`) without touching the
  /// session itself — used after an action that changes the user's own
  /// record server-side but not their tokens (e.g. confirming email/phone
  /// verification).
  Future<AppUser> fetchCurrentUser();

  Future<AppUser> register({
    required String email,
    required String username,
    required String password,
    required DateTime dateOfBirth,
    String? phoneNumber,
  });

  Future<LoginResult> login({
    required String identifier,
    required String password,
  });

  /// Completes a login that [login] paused for an MFA challenge. [code]
  /// may be a 6-digit TOTP code or an 8-character recovery code — the API
  /// accepts either in the same field.
  Future<AppUser> verifyMfaLogin({
    required String mfaChallengeToken,
    required String code,
  });

  Future<void> logout();

  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
  });

  /// Requests a password reset code. Always succeeds with the identical
  /// generic server message whether or not [identifier] matches an
  /// account — never used to infer account existence.
  Future<String> requestPasswordReset(String identifier);

  /// Completes a password reset. Revokes every existing session for the
  /// account server-side; this device's own session is cleared as part
  /// of that, so the caller must send the user back through [login].
  Future<void> confirmPasswordReset({
    required String token,
    required String newPassword,
  });

  /// Sends a one-time verification code for [channel] (`'EMAIL'` or
  /// `'SMS'`) to the authenticated user.
  Future<void> requestVerification(String channel);

  /// Confirms a verification code for [channel].
  Future<void> confirmVerification({
    required String channel,
    required String code,
  });
}

class HttpAuthRepository implements AuthRepository {
  const HttpAuthRepository({
    required this.apiClient,
    required this.secureStorage,
  });

  final ApiClient apiClient;
  final SecureStorage secureStorage;

  @override
  Future<AppUser?> loadSession() async {
    final accessToken = await secureStorage.read(AuthStorageKeys.accessToken);
    if (accessToken == null) return null;

    try {
      final response = await apiClient.get<Map<String, dynamic>>('/auth/me');
      return AppUser.fromJson(response.data!);
    } on NetworkException catch (e) {
      // `ApiClient` has already renewed an expired access token and retried
      // (see `SessionRefresher`), so a 401 that gets here means the session is
      // really over. Refreshing again here would race that single-flight
      // refresh and present an already-rotated token.
      if (e.statusCode == 401) {
        await _clearSession();
        return null;
      }
      rethrow;
    }
  }

  @override
  Future<AppUser> fetchCurrentUser() async {
    final response = await apiClient.get<Map<String, dynamic>>('/auth/me');
    return AppUser.fromJson(response.data!);
  }

  @override
  Future<AppUser> register({
    required String email,
    required String username,
    required String password,
    required DateTime dateOfBirth,
    String? phoneNumber,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/auth/register',
      data: {
        'email': email,
        'username': username,
        'password': password,
        'dateOfBirth': dateOfBirth.toIso8601String().split('T').first,
        if (phoneNumber != null && phoneNumber.isNotEmpty)
          'phoneNumber': phoneNumber,
      },
    );
    return _persistAuthResponse(response.data!);
  }

  @override
  Future<LoginResult> login({
    required String identifier,
    required String password,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/auth/login',
      data: {'identifier': identifier, 'password': password},
    );
    final body = response.data!;
    if (body['mfaRequired'] == true) {
      return LoginMfaRequired(body['mfaChallengeToken'] as String);
    }
    return LoginSuccess(await _persistAuthResponse(body));
  }

  @override
  Future<AppUser> verifyMfaLogin({
    required String mfaChallengeToken,
    required String code,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/auth/mfa/verify',
      data: {'mfaChallengeToken': mfaChallengeToken, 'code': code},
    );
    return _persistAuthResponse(response.data!);
  }

  @override
  Future<void> logout() async {
    final refreshToken = await secureStorage.read(AuthStorageKeys.refreshToken);
    if (refreshToken != null) {
      try {
        await apiClient.post<void>(
          '/auth/logout',
          data: {'refreshToken': refreshToken},
        );
      } on NetworkException {
        // Best-effort: even if the server call fails (e.g. offline), the
        // local session must still be cleared below.
      }
    }
    await _clearSession();
  }

  @override
  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    await apiClient.post<void>(
      '/auth/change-password',
      data: {'currentPassword': currentPassword, 'newPassword': newPassword},
    );
    // The API revokes every session on password change, including this
    // device's refresh token — the user must log in again.
    await _clearSession();
  }

  @override
  Future<String> requestPasswordReset(String identifier) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/auth/password-reset/request',
      data: {'identifier': identifier},
    );
    return response.data!['message'] as String;
  }

  @override
  Future<void> confirmPasswordReset({
    required String token,
    required String newPassword,
  }) async {
    await apiClient.post<void>(
      '/auth/password-reset/confirm',
      data: {'token': token, 'newPassword': newPassword},
    );
    // The API revokes every existing session (including this device's)
    // on a successful reset — clear whatever we had locally too.
    await _clearSession();
  }

  @override
  Future<void> requestVerification(String channel) async {
    await apiClient.post<void>(
      '/auth/verification/request',
      data: {'channel': channel},
    );
  }

  @override
  Future<void> confirmVerification({
    required String channel,
    required String code,
  }) async {
    await apiClient.post<void>(
      '/auth/verification/confirm',
      data: {'channel': channel, 'code': code},
    );
  }

  Future<AppUser> _persistAuthResponse(Map<String, dynamic> body) async {
    await secureStorage.write(
      AuthStorageKeys.accessToken,
      body['accessToken'] as String,
    );
    await secureStorage.write(
      AuthStorageKeys.refreshToken,
      body['refreshToken'] as String,
    );
    return AppUser.fromJson(body['user'] as Map<String, dynamic>);
  }

  Future<void> _clearSession() async {
    await secureStorage.delete(AuthStorageKeys.accessToken);
    await secureStorage.delete(AuthStorageKeys.refreshToken);
  }
}
