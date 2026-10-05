import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../errors/app_exception.dart';

/// Secure storage abstraction for sensitive values (auth tokens). Backed by
/// the Android Keystore / iOS Keychain via `flutter_secure_storage`, never
/// plain `SharedPreferences` — see [LocalStorage] for the non-sensitive
/// equivalent and docs/architecture/SECURITY.md.
abstract class SecureStorage {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
  Future<void> deleteAll();
}

class FlutterSecureStorageAdapter implements SecureStorage {
  const FlutterSecureStorageAdapter([
    this._storage = const FlutterSecureStorage(),
  ]);

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) async {
    try {
      return await _storage.read(key: key);
    } catch (e) {
      throw StorageException('Failed to read secure value "$key": $e');
    }
  }

  @override
  Future<void> write(String key, String value) async {
    try {
      await _storage.write(key: key, value: value);
    } catch (e) {
      throw StorageException('Failed to write secure value "$key": $e');
    }
  }

  @override
  Future<void> delete(String key) async {
    await _storage.delete(key: key);
  }

  @override
  Future<void> deleteAll() async {
    await _storage.deleteAll();
  }
}
