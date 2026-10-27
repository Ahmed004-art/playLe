/// What happened when the app tried to renew an expired access token.
enum SessionRefreshResult {
  /// New tokens were obtained and stored; the failed request can be retried.
  refreshed,

  /// The server refused the refresh token (expired, revoked, or none stored).
  /// The session is over: local tokens have been cleared and the user must
  /// sign in again.
  rejected,

  /// The refresh could not be attempted or finished (no connection, a server
  /// error). The session may still be valid: nothing was cleared.
  unavailable,
}

/// Renews the session's tokens. Called by `ApiClient` when a request fails
/// with 401, and expected to be safe to call from several requests at once
/// (see `SessionRefresher`).
typedef SessionRefreshCallback = Future<SessionRefreshResult> Function();
