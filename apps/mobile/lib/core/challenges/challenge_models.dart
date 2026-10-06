/// Mirrors the API's `ChallengeResponseDto`. `stakeAmountMinor`/
/// `stakeCurrency` are `null` for ordinary free play — a stake is
/// immutable once a challenge is created; accepting it commits to
/// exactly this amount (see
/// docs/decisions/ADR-016-match-financial-architecture.md).
class ChallengeInfo {
  const ChallengeInfo({
    required this.id,
    required this.gameId,
    required this.challengerId,
    required this.opponentId,
    required this.status,
    required this.matchId,
    required this.createdAt,
    this.stakeAmountMinor,
    this.stakeCurrency,
  });

  factory ChallengeInfo.fromJson(Map<String, dynamic> json) {
    return ChallengeInfo(
      id: json['id'] as String,
      gameId: json['gameId'] as String,
      challengerId: json['challengerId'] as String,
      opponentId: json['opponentId'] as String,
      status: json['status'] as String,
      matchId: json['matchId'] as String?,
      createdAt: DateTime.parse(json['createdAt'] as String),
      stakeAmountMinor: json['stakeAmountMinor'] as String?,
      stakeCurrency: json['stakeCurrency'] as String?,
    );
  }

  final String id;
  final String gameId;
  final String challengerId;
  final String opponentId;
  final String status;
  final String? matchId;
  final DateTime createdAt;
  final String? stakeAmountMinor;
  final String? stakeCurrency;

  bool get isFinanciallyBacked => stakeAmountMinor != null;

  bool isIncomingFor(String userId) =>
      status == 'PENDING' && opponentId == userId;
}
