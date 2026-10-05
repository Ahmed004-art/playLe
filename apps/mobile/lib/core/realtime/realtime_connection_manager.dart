import '../auth/auth_repository.dart';
import '../network/websocket_client.dart';
import '../storage/secure_storage.dart';

/// Keeps the [WebSocketClient] connected while the user has a session,
/// and disconnected otherwise. Reads the access token directly from
/// [SecureStorage] rather than depending on [AuthController] — this
/// keeps the already-tested Phase 2 `AuthController` free of any
/// realtime-specific dependency; `main.dart` wires the two together by
/// reacting to auth state changes (see `connect`/`disconnect` call
/// sites there).
class RealtimeConnectionManager {
  RealtimeConnectionManager({
    required this.webSocketClient,
    required this.secureStorage,
  });

  final WebSocketClient webSocketClient;
  final SecureStorage secureStorage;

  Future<void> connect() async {
    if (webSocketClient.isConnected) return;
    final token = await secureStorage.read(AuthStorageKeys.accessToken);
    if (token == null) return;
    webSocketClient.connect(token);
  }

  void disconnect() => webSocketClient.disconnect();
}
