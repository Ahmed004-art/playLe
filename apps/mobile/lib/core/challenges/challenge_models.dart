/// Mirrors the API's `ChallengeResponseDto`.
class ChallengeInfo {
  const ChallengeInfo({
    required this.id,
    required this.gameId,
    required this.challengerId,
    required this.opponentId,
    required this.status,
    required this.matchId,
    required this.createdAt,
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
    );
  }

  final String id;
  final String gameId;
  final String challengerId;
  final String opponentId;
  final String status;
  final String? matchId;
  final DateTime createdAt;

  bool isIncomingFor(String userId) =>
      status == 'PENDING' && opponentId == userId;
}
