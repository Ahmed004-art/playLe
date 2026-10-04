import 'package:logger/logger.dart';

/// Structured logging foundation for PlayLe.
///
/// Wraps `package:logger` so call sites depend on this abstraction rather
/// than a specific logging library. Never log secrets, tokens, or payment
/// credentials through this logger — see docs/architecture/SECURITY.md.
///
/// Future phases will extend this with dedicated categories for
/// authentication, game, financial, and security events (mirroring the
/// backend's structured logging — see apps/api/src/common/logging).
class AppLogger {
  AppLogger._(this._logger);

  final Logger _logger;

  static final AppLogger instance = AppLogger._(
    Logger(printer: PrettyPrinter(methodCount: 0, colors: false)),
  );

  void debug(String message) => _logger.d(message);
  void info(String message) => _logger.i(message);
  void warning(String message) => _logger.w(message);
  void error(String message, [Object? error, StackTrace? stackTrace]) =>
      _logger.e(message, error: error, stackTrace: stackTrace);
}
