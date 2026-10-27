import '../errors/app_exception.dart';

/// The ways a social request can fail that a screen shows differently.
enum SocialFailureKind {
  /// The session is no longer valid (HTTP 401): the user must sign in again.
  unauthorized,

  /// The player does not exist or may not be seen (HTTP 404), or the id was
  /// malformed (HTTP 400). The API deliberately does not say which, and this
  /// app does not try to find out.
  notFound,

  /// Anything else: no connection, a server error, an unexpected response.
  other,
}

SocialFailureKind classifyFailure(Object error) {
  if (error is NetworkException) {
    final code = error.statusCode;
    if (code == 401) {
      return SocialFailureKind.unauthorized;
    }
    if (code == 404 || code == 400) {
      return SocialFailureKind.notFound;
    }
  }
  return SocialFailureKind.other;
}

/// A message safe to show the user for a failure that is neither
/// [SocialFailureKind.unauthorized] nor [SocialFailureKind.notFound].
String friendlyFailureMessage(Object error) {
  if (error is NetworkException) {
    final code = error.statusCode;
    if (code == null) {
      return 'Could not reach PlayLe. Check your connection and try again.';
    }
    if (code >= 500) {
      return 'Something went wrong on our side. Please try again.';
    }
    return error.message;
  }
  if (error is AppException) {
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
