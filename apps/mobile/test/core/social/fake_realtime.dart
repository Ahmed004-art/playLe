import 'package:playle_mobile/core/config/app_config.dart';
import 'package:playle_mobile/core/network/websocket_client.dart';
import 'package:playle_mobile/core/realtime/realtime_connection_manager.dart';

import '../realtime/fake_secure_storage.dart';

const _config = AppConfig(
  environment: Environment.development,
  apiBaseUrl: 'http://localhost:0/api/v1',
  socketUrl: 'http://localhost:0',
);

/// A [WebSocketClient] that never opens a socket. It records who is listening
/// to which event, so tests can push a server event and check that listeners
/// are added once and removed on dispose.
class FakeWebSocketClient extends WebSocketClient {
  FakeWebSocketClient() : super(config: _config);

  final Map<String, List<void Function(dynamic data)>> _handlers = {};

  /// How many subscriptions were ever made.
  int subscribeCalls = 0;

  @override
  void Function() on(String event, void Function(dynamic data) handler) {
    subscribeCalls++;
    _handlers.putIfAbsent(event, () => []).add(handler);
    return () => _handlers[event]?.remove(handler);
  }

  int listenerCount(String event) => _handlers[event]?.length ?? 0;

  /// Pushes a server event to whoever is currently listening.
  void pushEvent(String event, [dynamic data]) {
    for (final handler in List.of(_handlers[event] ?? [])) {
      handler(data);
    }
  }
}

/// A [RealtimeConnectionManager] that only counts connect requests.
class FakeRealtime extends RealtimeConnectionManager {
  FakeRealtime(WebSocketClient client)
    : super(webSocketClient: client, secureStorage: FakeSecureStorage());

  int connectCalls = 0;

  @override
  Future<void> connect() async {
    connectCalls++;
  }
}
