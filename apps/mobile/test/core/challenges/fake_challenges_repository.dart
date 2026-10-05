import 'package:playle_mobile/core/challenges/challenge_models.dart';
import 'package:playle_mobile/core/challenges/challenges_repository.dart';

final testChallenge = ChallengeInfo(
  id: 'challenge-1',
  gameId: 'tic_tac_toe',
  challengerId: 'user-1',
  opponentId: 'user-2',
  status: 'PENDING',
  matchId: null,
  createdAt: DateTime.now(),
);

class FakeChallengesRepository implements ChallengesRepository {
  List<ChallengeInfo> challengesToReturn = [];
  String userIdToReturn = 'user-2';

  @override
  Future<ChallengeInfo> create(String gameId, String opponentUserId) async =>
      testChallenge;

  @override
  Future<List<ChallengeInfo>> list() async => challengesToReturn;

  @override
  Future<ChallengeInfo> accept(String challengeId) async =>
      _withStatus('ACCEPTED');

  @override
  Future<ChallengeInfo> decline(String challengeId) async =>
      _withStatus('DECLINED');

  @override
  Future<ChallengeInfo> cancel(String challengeId) async =>
      _withStatus('CANCELLED');

  @override
  Future<String> lookupUserIdByUsername(String username) async =>
      userIdToReturn;

  ChallengeInfo _withStatus(String status) => ChallengeInfo(
    id: testChallenge.id,
    gameId: testChallenge.gameId,
    challengerId: testChallenge.challengerId,
    opponentId: testChallenge.opponentId,
    status: status,
    matchId: testChallenge.matchId,
    createdAt: testChallenge.createdAt,
  );
}
