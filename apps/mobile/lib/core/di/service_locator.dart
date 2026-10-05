import 'package:get_it/get_it.dart';

import '../auth/auth_controller.dart';
import '../auth/auth_repository.dart';
import '../config/app_config.dart';
import '../network/api_client.dart';
import '../network/websocket_client.dart';
import '../storage/local_storage.dart';
import '../storage/secure_storage.dart';
import '../wallet/wallet_controller.dart';
import '../wallet/wallet_repository.dart';

/// Dependency injection strategy: a single `get_it` service locator.
///
/// Chosen over a widget-tree-based DI (e.g. Provider/Riverpod) because most
/// of PlayLe's core services (API client, storage, sockets) are not
/// tied to the widget lifecycle and are needed outside `BuildContext`
/// (e.g. in interceptors, background reconnect logic). Feature-level state
/// management can still be layered on top of these services later without
/// changing this registration strategy.
final GetIt sl = GetIt.instance;

Future<void> setupServiceLocator() async {
  final config = AppConfig.fromEnvironment();
  sl.registerSingleton<AppConfig>(config);

  sl.registerLazySingleton<LocalStorage>(
    () => const SharedPreferencesStorage(),
  );
  sl.registerLazySingleton<SecureStorage>(
    () => const FlutterSecureStorageAdapter(),
  );

  sl.registerLazySingleton<ApiClient>(
    () => ApiClient(
      config: config,
      getAccessToken: () =>
          sl<SecureStorage>().read(AuthStorageKeys.accessToken),
    ),
  );
  sl.registerLazySingleton<WebSocketClient>(
    () => WebSocketClient(config: config),
  );

  sl.registerLazySingleton<AuthRepository>(
    () => HttpAuthRepository(
      apiClient: sl<ApiClient>(),
      secureStorage: sl<SecureStorage>(),
    ),
  );
  sl.registerLazySingleton<AuthController>(
    () => AuthController(sl<AuthRepository>()),
  );

  sl.registerLazySingleton<WalletRepository>(
    () => HttpWalletRepository(apiClient: sl<ApiClient>()),
  );
  sl.registerLazySingleton<WalletController>(
    () => WalletController(sl<WalletRepository>()),
  );
}
