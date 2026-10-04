import 'package:shared_preferences/shared_preferences.dart';

import '../errors/app_exception.dart';

/// Local storage abstraction. Call sites depend on this interface, not on
/// `package:shared_preferences` directly, so the backing implementation can
/// be swapped (e.g. to secure storage for sensitive values such as auth
/// tokens) without touching feature code.
abstract class LocalStorage {
  Future<String?> getString(String key);
  Future<void> setString(String key, String value);
  Future<void> remove(String key);
  Future<void> clear();
}

class SharedPreferencesStorage implements LocalStorage {
  const SharedPreferencesStorage();

  Future<SharedPreferences> get _prefs => SharedPreferences.getInstance();

  @override
  Future<String?> getString(String key) async {
    try {
      final prefs = await _prefs;
      return prefs.getString(key);
    } catch (e) {
      throw StorageException('Failed to read "$key": $e');
    }
  }

  @override
  Future<void> setString(String key, String value) async {
    try {
      final prefs = await _prefs;
      await prefs.setString(key, value);
    } catch (e) {
      throw StorageException('Failed to write "$key": $e');
    }
  }

  @override
  Future<void> remove(String key) async {
    final prefs = await _prefs;
    await prefs.remove(key);
  }

  @override
  Future<void> clear() async {
    final prefs = await _prefs;
    await prefs.clear();
  }
}
