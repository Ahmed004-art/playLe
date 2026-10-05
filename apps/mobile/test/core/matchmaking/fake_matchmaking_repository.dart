import 'package:playle_mobile/core/matchmaking/matchmaking_repository.dart';

class FakeMatchmakingRepository implements MatchmakingRepository {
  MatchmakingJoinResult joinResult = const MatchmakingJoinResult(
    status: 'QUEUED',
  );
  bool left = false;

  @override
  Future<MatchmakingJoinResult> join(String gameId) async => joinResult;

  @override
  Future<void> leave(String gameId) async {
    left = true;
  }
}
