/// Mirrors the API's `ResponsibleGamingRestriction` model (see
/// `apps/api/prisma/schema.prisma`). `type` is one of `SELF_EXCLUSION`/
/// `DEPOSIT_LIMIT`/`STAKE_LIMIT`/`LOSS_LIMIT`/`COOLING_OFF`; `status` is
/// one of `ACTIVE`/`EXPIRED`/`LIFTED`. A restriction row is never
/// destructively edited server-side — a change is always a new row —
/// and `SELF_EXCLUSION` has no lift path anywhere in the API (see
/// docs/decisions/ADR-021-eligibility-and-responsible-gaming.md), so
/// this app never offers one either.
class RestrictionInfo {
  const RestrictionInfo({
    required this.id,
    required this.type,
    required this.status,
    required this.config,
    required this.startsAt,
    required this.createdAt,
    this.endsAt,
    this.liftedAt,
    this.liftedReason,
  });

  factory RestrictionInfo.fromJson(Map<String, dynamic> json) {
    return RestrictionInfo(
      id: json['id'] as String,
      type: json['type'] as String,
      status: json['status'] as String,
      config: (json['config'] as Map<String, dynamic>?) ?? const {},
      startsAt: DateTime.parse(json['startsAt'] as String),
      createdAt: DateTime.parse(json['createdAt'] as String),
      endsAt: json['endsAt'] == null
          ? null
          : DateTime.parse(json['endsAt'] as String),
      liftedAt: json['liftedAt'] == null
          ? null
          : DateTime.parse(json['liftedAt'] as String),
      liftedReason: json['liftedReason'] as String?,
    );
  }

  final String id;
  final String type;
  final String status;
  final Map<String, dynamic> config;
  final DateTime startsAt;
  final DateTime createdAt;
  final DateTime? endsAt;
  final DateTime? liftedAt;
  final String? liftedReason;

  /// The configured limit, for `DEPOSIT_LIMIT`/`STAKE_LIMIT`/
  /// `LOSS_LIMIT` — a decimal minor-units string, same convention as
  /// every other amount in this app. Null for `SELF_EXCLUSION`/
  /// `COOLING_OFF`, whose `config` is `{}`.
  String? get limitMinor => config['limitMinor'] as String?;
}
