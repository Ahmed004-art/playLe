import 'package:playle_mobile/core/match_stakes/match_stake_models.dart';
import 'package:playle_mobile/core/matchmaking/matchmaking_repository.dart';

class FakeMatchmakingRepository implements MatchmakingRepository {
  MatchmakingJoinResult joinResult = const MatchmakingJoinResult(
    status: 'QUEUED',
  );
  bool left = false;
  MatchStakeRequest? lastStakeRequested;

  @override
  Future<MatchmakingJoinResult> join(
    String gameId, {
    MatchStakeRequest? stake,
  }) async {
    lastStakeRequested = stake;
    return joinResult;
  }

  @override
  Future<void> leave(String gameId) async {
    left = true;
  }
}
