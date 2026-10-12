import 'session_models.dart';

sealed class SessionsState {
  const SessionsState();
}

class SessionsLoading extends SessionsState {
  const SessionsLoading();
}

class SessionsLoaded extends SessionsState {
  const SessionsLoaded(this.sessions);

  final List<SessionInfo> sessions;
}

class SessionsLoadError extends SessionsState {
  const SessionsLoadError(this.message);

  final String message;
}
