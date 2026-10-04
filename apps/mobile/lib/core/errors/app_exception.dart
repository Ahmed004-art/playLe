/// Base error-handling foundation for PlayLe.
///
/// All app-level failures should be represented as an [AppException]
/// subtype so UI code can handle them uniformly instead of catching raw
/// platform/package exceptions throughout the widget tree.
sealed class AppException implements Exception {
  const AppException(this.message);

  final String message;

  @override
  String toString() => '$runtimeType: $message';
}

/// Network/API failure (connection error, non-2xx response, timeout).
class NetworkException extends AppException {
  const NetworkException(super.message, {this.statusCode});

  final int? statusCode;
}

/// Local storage read/write failure.
class StorageException extends AppException {
  const StorageException(super.message);
}

/// Real-time (WebSocket) connection failure.
class RealtimeException extends AppException {
  const RealtimeException(super.message);
}

/// Thrown by abstractions whose concrete implementation is not yet built
/// (e.g. authentication) — makes "not implemented yet" explicit and
/// greppable rather than a generic UnimplementedError.
class NotImplementedException extends AppException {
  const NotImplementedException(String feature)
    : super('$feature is not implemented yet');
}
