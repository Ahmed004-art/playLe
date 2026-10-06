import 'dispute_models.dart';

/// Mirrors `core/challenges/challenges_state.dart`'s shape exactly.
sealed class DisputesState {
  const DisputesState();
}

class DisputesLoading extends DisputesState {
  const DisputesLoading();
}

class DisputesLoaded extends DisputesState {
  const DisputesLoaded(this.disputes);
  final List<DisputeInfo> disputes;
}

class DisputesLoadError extends DisputesState {
  const DisputesLoadError(this.message);
  final String message;
}
