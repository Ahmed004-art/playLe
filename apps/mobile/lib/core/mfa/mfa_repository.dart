import '../network/api_client.dart';
import 'mfa_models.dart';

/// Self-service TOTP MFA management for the authenticated account —
/// mirrors `apps/api/src/mfa/mfa.controller.ts`. The login-time
/// *challenge* (`/auth/mfa/verify`) lives on `AuthRepository`/
/// `AuthController` instead, since it's part of the login flow, not
/// account management — same split as the backend's
/// `AuthController`/`MfaController`.
abstract class MfaRepository {
  Future<bool> getStatus();

  /// Starts (or resumes) enrollment. Enforces nothing until [confirm]
  /// succeeds.
  Future<MfaEnrollment> enroll();

  /// Proves the enrolled device works; enables MFA and returns
  /// single-use recovery codes, shown exactly once by the caller.
  Future<List<String>> confirm(String code);

  /// Disables MFA. Requires a current, valid TOTP code.
  Future<void> disable(String code);
}

class HttpMfaRepository implements MfaRepository {
  const HttpMfaRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<bool> getStatus() async {
    final response = await apiClient.get<Map<String, dynamic>>(
      '/auth/mfa/status',
    );
    return response.data!['enabled'] as bool;
  }

  @override
  Future<MfaEnrollment> enroll() async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/auth/mfa/enroll',
    );
    return MfaEnrollment.fromJson(response.data!);
  }

  @override
  Future<List<String>> confirm(String code) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/auth/mfa/confirm',
      data: {'code': code},
    );
    return (response.data!['recoveryCodes'] as List<dynamic>).cast<String>();
  }

  @override
  Future<void> disable(String code) async {
    await apiClient.post<void>('/auth/mfa/disable', data: {'code': code});
  }
}
