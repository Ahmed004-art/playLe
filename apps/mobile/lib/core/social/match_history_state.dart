import 'social_models.dart';

/// One row of the match history, ready to show: the stored match, how the
/// viewer should see its result, and names resolved from the API (never
/// invented - an unresolved name is shown as such).
class MatchHistoryItem {
  const MatchHistoryItem({
    required this.entry,
    required this.result,
    required this.gameLabel,
    required this.opponentLabel,
    required this.opponentUserId,
  });

  final MatchHistoryEntry entry;
  final MatchResultView result;
  final String gameLabel;

  /// Who the viewer played: the opponent's display name or username, or a
  /// neutral placeholder when the API did not reveal them.
  final String opponentLabel;

  /// The opponent's id when the match had exactly one, so their profile can
  /// be opened; `null` otherwise.
  final String? opponentUserId;

  DateTime get when => entry.when;
}

sealed class MatchHistoryState {
  const MatchHistoryState();
}

class MatchHistoryLoading extends MatchHistoryState {
  const MatchHistoryLoading();
}

class MatchHistoryLoaded extends MatchHistoryState {
  const MatchHistoryLoaded({
    required this.items,
    required this.hasMore,
    this.isLoadingMore = false,
    this.loadMoreError,
  });

  final List<MatchHistoryItem> items;
  final bool hasMore;
  final bool isLoadingMore;

  /// Set when fetching a further page failed; the pages already shown stay.
  final String? loadMoreError;
}

class MatchHistoryError extends MatchHistoryState {
  const MatchHistoryError(this.message);
  final String message;
}

/// The session is no longer valid; the user must sign in again.
class MatchHistoryUnauthorized extends MatchHistoryState {
  const MatchHistoryUnauthorized();
}
