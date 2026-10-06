import 'package:playle_mobile/core/match/match_models.dart';
import 'package:playle_mobile/core/match/match_repository.dart';
import 'package:playle_mobile/core/match_stakes/match_stake_models.dart';

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

MatchStakeInfo buildTestStake({
  String id = 'stake-1',
  String status = 'PENDING',
  String stakeAmountMinor = '1000',
  String poolAmountMinor = '2000',
  List<MatchStakePlayerInfo>? players,
}) {
  return MatchStakeInfo(
    id: id,
    status: status,
    currency: 'SLE',
    stakeAmountMinor: stakeAmountMinor,
    poolAmountMinor: poolAmountMinor,
    players:
        players ??
        const [
          MatchStakePlayerInfo(userId: 'user-1', heldAt: null),
          MatchStakePlayerInfo(userId: 'user-2', heldAt: null),
        ],
  );
}

SettlementInfo buildTestSettlement({
  String outcome = 'WIN',
  String poolAmountMinor = '2000',
  String platformFeeAmountMinor = '200',
  List<SettlementEntryInfo>? entries,
}) {
  return SettlementInfo(
    id: 'settlement-1',
    outcome: outcome,
    status: 'SETTLED',
    currency: 'SLE',
    poolAmountMinor: poolAmountMinor,
    platformFeeAmountMinor: platformFeeAmountMinor,
    entries:
        entries ??
        const [
          SettlementEntryInfo(
            userId: 'user-1',
            role: 'WINNER',
            availableDeltaMinor: '1800',
            heldDeltaMinor: '-1000',
          ),
          SettlementEntryInfo(
            userId: 'user-2',
            role: 'LOSER',
            availableDeltaMinor: '0',
            heldDeltaMinor: '-1000',
          ),
        ],
    completedAt: DateTime.utc(2026, 1, 1),
  );
}

class FakeMatchRepository implements MatchRepository {
  MatchInfo matchToReturn = buildTestMatch();
  CommandResult commandResultToReturn = const CommandResult(
    resultStatus: 'ACCEPTED',
    rejectionReason: null,
  );
  List<Map<String, dynamic>> submittedPayloads = [];
  MatchFinancialInfo financialToReturn = const MatchFinancialInfo.empty();
  int confirmStakeCallCount = 0;
  Object? confirmStakeError;

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

  @override
  Future<MatchFinancialInfo> getFinancial(String matchId) async =>
      financialToReturn;

  @override
  Future<MatchFinancialInfo> confirmStake(String matchId) async {
    confirmStakeCallCount++;
    if (confirmStakeError != null) throw confirmStakeError!;
    return financialToReturn;
  }
}
