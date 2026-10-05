import 'match_models.dart';

sealed class MatchViewState {
  const MatchViewState();
}

class MatchViewLoading extends MatchViewState {
  const MatchViewLoading();
}

class MatchViewLoaded extends MatchViewState {
  const MatchViewLoaded(this.match, {this.lastRejection});

  final MatchInfo match;

  /// Set only right after a rejected move, so the UI can show *why* —
  /// never a client-decided outcome, just the server's own reason.
  final String? lastRejection;
}

class MatchViewError extends MatchViewState {
  const MatchViewError(this.message);
  final String message;
}
