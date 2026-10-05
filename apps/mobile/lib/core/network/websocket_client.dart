import 'package:socket_io_client/socket_io_client.dart' as socket_io;

import '../config/app_config.dart';
import '../logging/app_logger.dart';

/// Real-time abstraction over the backend's Socket.IO gateway (see
/// `apps/api/src/realtime` and
/// docs/decisions/ADR-014-realtime-command-transport.md). Match **commands**
/// (moves) still travel over REST via [ApiClient] — this client is only
/// for server→client push (match:found, match:state, challenge:received,
/// ...) and for joining a match's room after REST has confirmed
/// membership. Call sites never emit a command-shaped event here.
class WebSocketClient {
  WebSocketClient({required AppConfig config}) : _url = config.socketUrl;

  final String _url;
  socket_io.Socket? _socket;

  bool get isConnected => _socket?.connected ?? false;

  /// Connects authenticated as [accessToken] — the server verifies this
  /// the same way it verifies a REST bearer token (see
  /// `RealtimeGateway.handleConnection`) and disconnects the socket if
  /// it's missing/invalid/expired.
  void connect(String accessToken) {
    disconnect();

    _socket = socket_io.io(
      _url,
      socket_io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': accessToken})
          .disableAutoConnect()
          .build(),
    );

    _socket!
      ..onConnect((_) => AppLogger.instance.info('WebSocket connected'))
      ..onDisconnect((_) => AppLogger.instance.info('WebSocket disconnected'))
      ..onConnectError(
        (error) =>
            AppLogger.instance.warning('WebSocket connect error: $error'),
      )
      ..connect();
  }

  void disconnect() {
    _socket?.disconnect();
    _socket?.dispose();
    _socket = null;
  }

  /// Subscribes to a server-pushed event. Returns an unsubscribe function.
  void Function() on(String event, void Function(dynamic data) handler) {
    _socket?.on(event, handler);
    return () => _socket?.off(event, handler);
  }

  /// The only outbound events are non-mutating: joining a match's room
  /// (`match:join`) and presence heartbeats (`presence:heartbeat`).
  void emit(String event, [Object? data]) {
    _socket?.emit(event, data);
  }
}
