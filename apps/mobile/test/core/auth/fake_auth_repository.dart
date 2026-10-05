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

  @override
  Future<AppUser?> loadSession() async {
    if (loadSessionError != null) throw loadSessionError!;
    return sessionToRestore;
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
  Future<AppUser> login({
    required String identifier,
    required String password,
  }) async {
    if (nextError != null) throw nextError!;
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
}
