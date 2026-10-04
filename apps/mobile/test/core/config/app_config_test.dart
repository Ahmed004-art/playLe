import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/config/app_config.dart';

void main() {
  group('AppConfig.fromEnvironment', () {
    test('defaults to the development environment', () {
      final config = AppConfig.fromEnvironment();

      expect(config.environment, Environment.development);
      expect(config.isProduction, isFalse);
      expect(config.apiBaseUrl, isNotEmpty);
      expect(config.socketUrl, isNotEmpty);
    });
  });
}
