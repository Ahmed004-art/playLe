import 'package:playle_mobile/core/disputes/dispute_models.dart';
import 'package:playle_mobile/core/disputes/disputes_repository.dart';

final testDispute = DisputeInfo(
  id: 'dispute-1',
  matchId: 'match-1',
  raisedByUserId: 'user-1',
  reason: 'Opponent disconnected and never came back.',
  status: 'OPEN',
  resolution: null,
  resolvedByAdminId: null,
  createdAt: DateTime.utc(2026, 1, 1),
  resolvedAt: null,
);

class FakeDisputesRepository implements DisputesRepository {
  List<DisputeInfo> disputesToReturn = [];
  DisputeInfo disputeToReturn = testDispute;
  String? lastCreatedMatchId;
  String? lastCreatedReason;
  Object? nextError;

  @override
  Future<List<DisputeInfo>> list() async {
    if (nextError != null) throw nextError!;
    return disputesToReturn;
  }

  @override
  Future<DisputeInfo> create(String matchId, String reason) async {
    if (nextError != null) throw nextError!;
    lastCreatedMatchId = matchId;
    lastCreatedReason = reason;
    return disputeToReturn;
  }
}
