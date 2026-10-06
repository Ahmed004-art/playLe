/// Mirrors the API's `DisputeResponseDto`. `status` is one of
/// `OPEN`/`UNDER_REVIEW`/`UPHELD`/`REFUNDED`/`RESOLVED` (see
/// docs/decisions/ADR-018-financial-state-machines.md). Filing or
/// resolving a dispute never itself moves money — see
/// `docs/api/README.md`'s "Match Stakes, Settlement & Disputes
/// Endpoints" section.
class DisputeInfo {
  const DisputeInfo({
    required this.id,
    required this.matchId,
    required this.raisedByUserId,
    required this.reason,
    required this.status,
    required this.resolution,
    required this.resolvedByAdminId,
    required this.createdAt,
    required this.resolvedAt,
  });

  factory DisputeInfo.fromJson(Map<String, dynamic> json) {
    return DisputeInfo(
      id: json['id'] as String,
      matchId: json['matchId'] as String,
      raisedByUserId: json['raisedByUserId'] as String,
      reason: json['reason'] as String,
      status: json['status'] as String,
      resolution: json['resolution'] as String?,
      resolvedByAdminId: json['resolvedByAdminId'] as String?,
      createdAt: DateTime.parse(json['createdAt'] as String),
      resolvedAt: json['resolvedAt'] == null
          ? null
          : DateTime.parse(json['resolvedAt'] as String),
    );
  }

  final String id;
  final String matchId;
  final String raisedByUserId;
  final String reason;
  final String status;
  final String? resolution;
  final String? resolvedByAdminId;
  final DateTime createdAt;
  final DateTime? resolvedAt;

  bool get isResolved => status != 'OPEN' && status != 'UNDER_REVIEW';
}
