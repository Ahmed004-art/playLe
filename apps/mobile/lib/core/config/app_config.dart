/// Environment configuration strategy for PlayLe.
///
/// The environment is selected at build time via `--dart-define=ENV=...`
/// (defaulting to [Environment.development]), e.g.:
///
/// ```
/// flutter run --dart-define=ENV=staging --dart-define=API_BASE_URL=https://staging.api.playle.example/api/v1
/// ```
///
/// This avoids bundling environment secrets/config as assets and keeps the
/// strategy compatible with both Android and iOS builds.
enum Environment { development, staging, production }

class AppConfig {
  const AppConfig({
    required this.environment,
    required this.apiBaseUrl,
    required this.socketUrl,
  });

  final Environment environment;
  final String apiBaseUrl;
  final String socketUrl;

  bool get isProduction => environment == Environment.production;

  static AppConfig fromEnvironment() {
    final envName = const String.fromEnvironment(
      'ENV',
      defaultValue: 'development',
    );
    final environment = Environment.values.firstWhere(
      (e) => e.name == envName,
      orElse: () => Environment.development,
    );

    const apiBaseUrl = String.fromEnvironment(
      'API_BASE_URL',
      defaultValue: 'http://10.0.2.2:3000/api/v1',
    );
    const socketUrl = String.fromEnvironment(
      'SOCKET_URL',
      defaultValue: 'http://10.0.2.2:3000',
    );

    return AppConfig(
      environment: environment,
      apiBaseUrl: apiBaseUrl,
      socketUrl: socketUrl,
    );
  }
}
