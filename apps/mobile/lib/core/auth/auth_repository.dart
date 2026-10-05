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

  Future<AppUser> register({
    required String email,
    required String username,
    required String password,
    required DateTime dateOfBirth,
    String? phoneNumber,
  });

  Future<AppUser> login({required String identifier, required String password});

  Future<void> logout();

  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
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
      if (e.statusCode == 401) {
        return _tryRefresh();
      }
      rethrow;
    }
  }

  Future<AppUser?> _tryRefresh() async {
    final refreshToken = await secureStorage.read(AuthStorageKeys.refreshToken);
    if (refreshToken == null) {
      await _clearSession();
      return null;
    }

    try {
      final response = await apiClient.post<Map<String, dynamic>>(
        '/auth/refresh',
        data: {'refreshToken': refreshToken},
      );
      return _persistAuthResponse(response.data!);
    } on NetworkException {
      await _clearSession();
      return null;
    }
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
  Future<AppUser> login({
    required String identifier,
    required String password,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/auth/login',
      data: {'identifier': identifier, 'password': password},
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
