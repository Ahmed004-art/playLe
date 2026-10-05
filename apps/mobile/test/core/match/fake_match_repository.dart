import 'package:playle_mobile/core/match/match_models.dart';
import 'package:playle_mobile/core/match/match_repository.dart';

MatchInfo buildTestMatch({
  String id = 'match-1',
  String status = 'ACTIVE',
  int stateVersion = 0,
  List<String?>? board,
  String? winnerUserId,
  bool resultIsDraw = false,
  List<MatchPlayerInfo>? players,
}) {
  return MatchInfo(
    id: id,
    gameId: 'tic_tac_toe',
    status: status,
    stateVersion: stateVersion,
    state: {
      'board': board ?? List<String?>.filled(9, null),
      'playerOrder': ['user-1', 'user-2'],
      'moveCount': stateVersion,
    },
    winnerUserId: winnerUserId,
    resultIsDraw: resultIsDraw,
    players:
        players ??
        const [
          MatchPlayerInfo(userId: 'user-1', seat: 0, connected: true),
          MatchPlayerInfo(userId: 'user-2', seat: 1, connected: true),
        ],
  );
}

class FakeMatchRepository implements MatchRepository {
  MatchInfo matchToReturn = buildTestMatch();
  CommandResult commandResultToReturn = const CommandResult(
    resultStatus: 'ACCEPTED',
    rejectionReason: null,
  );
  List<Map<String, dynamic>> submittedPayloads = [];

  @override
  Future<MatchInfo> getMatch(String matchId) async => matchToReturn;

  @override
  Future<List<MatchInfo>> listMatches() async => [matchToReturn];

  @override
  Future<CommandResult> submitCommand(
    String matchId,
    Map<String, dynamic> payload,
  ) async {
    submittedPayloads.add(payload);
    return commandResultToReturn;
  }
}
