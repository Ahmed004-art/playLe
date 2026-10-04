import '../errors/app_exception.dart';

/// Authentication abstraction (placeholder).
///
/// Defines the contract feature code will use once real authentication is
/// implemented. No real authentication exists in Phase 1 — see
/// docs/architecture/SECURITY.md, "Authentication architecture
/// (placeholder)". [NoOpAuthRepository] exists only so the app can boot
/// and the DI graph is wired end-to-end; it must be replaced, not extended
/// in place, when real auth is implemented.
abstract class AuthRepository {
  Future<bool> get isAuthenticated;
  Future<void> signIn({required String identifier, required String credential});
  Future<void> signOut();
}

class NoOpAuthRepository implements AuthRepository {
  const NoOpAuthRepository();

  @override
  Future<bool> get isAuthenticated async => false;

  @override
  Future<void> signIn({
    required String identifier,
    required String credential,
  }) {
    throw const NotImplementedException('Authentication');
  }

  @override
  Future<void> signOut() async {}
}
