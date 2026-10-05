import 'package:playle_mobile/core/storage/secure_storage.dart';

/// In-memory [SecureStorage] fake — no platform channel calls, safe for
/// widget/unit tests.
class FakeSecureStorage implements SecureStorage {
  final Map<String, String> _values = {};

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async {
    _values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    _values.remove(key);
  }

  @override
  Future<void> deleteAll() async {
    _values.clear();
  }
}
