import 'challenge_models.dart';

sealed class ChallengesState {
  const ChallengesState();
}

class ChallengesLoading extends ChallengesState {
  const ChallengesLoading();
}

class ChallengesLoaded extends ChallengesState {
  const ChallengesLoaded(this.challenges);
  final List<ChallengeInfo> challenges;
}

class ChallengesLoadError extends ChallengesState {
  const ChallengesLoadError(this.message);
  final String message;
}
