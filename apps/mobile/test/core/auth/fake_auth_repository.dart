import 'package:playle_mobile/core/auth/app_user.dart';
import 'package:playle_mobile/core/auth/auth_repository.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';

const testUser = AppUser(
  id: 'user-1',
  email: 'player@example.com',
  username: 'playerone',
  role: 'USER',
  status: 'ACTIVE',
);

/// A controllable [AuthRepository] fake for testing [AuthController] and
/// routing without a real network/secure-storage dependency.
class FakeAuthRepository implements AuthRepository {
  AppUser? sessionToRestore;
  AppException? loadSessionError;
  AppException? nextError;
  bool loggedOut = false;
  bool changedPassword = false;

  /// When set, [login] returns an MFA challenge instead of succeeding.
  String? mfaChallengeTokenToReturn;
  String? lastMfaVerifyCode;
  String? mfaVerifyError;

  AppUser userToReturnFromFetch = testUser;
  String? lastRequestedPasswordResetIdentifier;
  String passwordResetMessageToReturn =
      'If an account exists for that identifier, a reset code has been sent.';
  bool passwordResetConfirmed = false;
  String? lastVerificationRequestChannel;
  String? lastVerificationConfirmChannel;
  String? lastVerificationConfirmCode;

  @override
  Future<AppUser?> loadSession() async {
    if (loadSessionError != null) throw loadSessionError!;
    return sessionToRestore;
  }

  @override
  Future<AppUser> fetchCurrentUser() async {
    if (nextError != null) throw nextError!;
    return userToReturnFromFetch;
  }

  @override
  Future<AppUser> register({
    required String email,
    required String username,
    required String password,
    required DateTime dateOfBirth,
    String? phoneNumber,
  }) async {
    if (nextError != null) throw nextError!;
    return testUser;
  }

  @override
  Future<LoginResult> login({
    required String identifier,
    required String password,
  }) async {
    if (nextError != null) throw nextError!;
    final challengeToken = mfaChallengeTokenToReturn;
    if (challengeToken != null) {
      return LoginMfaRequired(challengeToken);
    }
    return LoginSuccess(testUser);
  }

  @override
  Future<AppUser> verifyMfaLogin({
    required String mfaChallengeToken,
    required String code,
  }) async {
    lastMfaVerifyCode = code;
    if (mfaVerifyError != null) {
      throw NetworkException(mfaVerifyError!, statusCode: 401);
    }
    return testUser;
  }

  @override
  Future<void> logout() async {
    loggedOut = true;
  }

  @override
  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    if (nextError != null) throw nextError!;
    changedPassword = true;
  }

  @override
  Future<String> requestPasswordReset(String identifier) async {
    if (nextError != null) throw nextError!;
    lastRequestedPasswordResetIdentifier = identifier;
    return passwordResetMessageToReturn;
  }

  @override
  Future<void> confirmPasswordReset({
    required String token,
    required String newPassword,
  }) async {
    if (nextError != null) throw nextError!;
    passwordResetConfirmed = true;
  }

  @override
  Future<void> requestVerification(String channel) async {
    if (nextError != null) throw nextError!;
    lastVerificationRequestChannel = channel;
  }

  @override
  Future<void> confirmVerification({
    required String channel,
    required String code,
  }) async {
    if (nextError != null) throw nextError!;
    lastVerificationConfirmChannel = channel;
    lastVerificationConfirmCode = code;
  }
}
