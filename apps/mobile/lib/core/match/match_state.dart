import '../match_stakes/match_stake_models.dart';
import 'match_models.dart';

sealed class MatchViewState {
  const MatchViewState();
}

class MatchViewLoading extends MatchViewState {
  const MatchViewLoading();
}

class MatchViewLoaded extends MatchViewState {
  const MatchViewLoaded(
    this.match, {
    this.lastRejection,
    this.financial = const MatchFinancialInfo.empty(),
  });

  final MatchInfo match;

  /// Set only right after a rejected move, so the UI can show *why* —
  /// never a client-decided outcome, just the server's own reason.
  final String? lastRejection;

  /// This match's stake/settlement, if any. Defaults to the "nothing
  /// financial here" shape so every free-play match (and every call
  /// site written before Phase 5) behaves exactly as before — see
  /// `MatchFinancialInfo.empty`.
  final MatchFinancialInfo financial;
}

class MatchViewError extends MatchViewState {
  const MatchViewError(this.message);
  final String message;
}
