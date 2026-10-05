sealed class MatchmakingState {
  const MatchmakingState();
}

class MatchmakingIdle extends MatchmakingState {
  const MatchmakingIdle();
}

class MatchmakingSearching extends MatchmakingState {
  const MatchmakingSearching();
}

class MatchmakingMatched extends MatchmakingState {
  const MatchmakingMatched(this.matchId);
  final String matchId;
}

class MatchmakingError extends MatchmakingState {
  const MatchmakingError(this.message);
  final String message;
}
