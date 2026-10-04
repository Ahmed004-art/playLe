import 'package:socket_io_client/socket_io_client.dart' as socket_io;

import '../config/app_config.dart';
import '../logging/app_logger.dart';

/// Connection-lifecycle-only WebSocket abstraction.
///
/// Matches the backend's Socket.IO gateway (see
/// apps/api/src/realtime and docs/decisions/ADR-006-realtime.md). No game
/// or domain events are wired up yet — this only proves the client can
/// connect/disconnect. Event handling is added alongside each real-time
/// feature (matchmaking, game sessions, etc.) in later phases.
class WebSocketClient {
  WebSocketClient({required AppConfig config}) : _url = config.socketUrl;

  final String _url;
  socket_io.Socket? _socket;

  bool get isConnected => _socket?.connected ?? false;

  void connect() {
    _socket = socket_io.io(
      _url,
      socket_io.OptionBuilder()
          .setTransports(['websocket'])
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
}
