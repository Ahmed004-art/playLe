/// Mirrors the API's `StakeRequestDto` — attached optionally to a
/// matchmaking-join or challenge-create request body. Passing `null`
/// (the default everywhere it's used) omits the field entirely, which
/// means ordinary free play — unchanged from Phase 4. See
/// docs/decisions/ADR-016-match-financial-architecture.md.
class MatchStakeRequest {
  const MatchStakeRequest({required this.amountMinor, this.currency = 'SLE'});

  /// Decimal string of integer minor units (1 SLE = 100 minor units) —
  /// never a `double`, matching every other money field in this app.
  final String amountMinor;
  final String currency;

  Map<String, dynamic> toJson() => {
    'amountMinor': amountMinor,
    'currency': currency,
  };
}

/// Mirrors the API's `MatchStakePlayerResponseDto`.
class MatchStakePlayerInfo {
  const MatchStakePlayerInfo({required this.userId, required this.heldAt});

  factory MatchStakePlayerInfo.fromJson(Map<String, dynamic> json) {
    return MatchStakePlayerInfo(
      userId: json['userId'] as String,
      heldAt: json['heldAt'] == null
          ? null
          : DateTime.parse(json['heldAt'] as String),
    );
  }

  final String userId;
  final DateTime? heldAt;
}

/// Mirrors the API's `MatchStakeResponseDto`. `status` is one of
/// `PENDING`/`HELD`/`ACTIVE`/`SETTLING`/`SETTLED`/`REFUNDED`/
/// `CANCELLED`/`DISPUTED`/`FAILED` (see
/// docs/decisions/ADR-018-financial-state-machines.md) — kept as a raw
/// string, same convention `MatchInfo.status` already uses for
/// `Match.status`.
class MatchStakeInfo {
  const MatchStakeInfo({
    required this.id,
    required this.status,
    required this.currency,
    required this.stakeAmountMinor,
    required this.poolAmountMinor,
    required this.players,
  });

  factory MatchStakeInfo.fromJson(Map<String, dynamic> json) {
    return MatchStakeInfo(
      id: json['id'] as String,
      status: json['status'] as String,
      currency: json['currency'] as String,
      stakeAmountMinor: json['stakeAmountMinor'] as String,
      poolAmountMinor: json['poolAmountMinor'] as String,
      players: (json['players'] as List<dynamic>)
          .cast<Map<String, dynamic>>()
          .map(MatchStakePlayerInfo.fromJson)
          .toList(),
    );
  }

  final String id;
  final String status;
  final String currency;
  final String stakeAmountMinor;
  final String poolAmountMinor;
  final List<MatchStakePlayerInfo> players;

  bool hasConfirmed(String userId) =>
      players.any((p) => p.userId == userId && p.heldAt != null);

  bool get allConfirmed => players.every((p) => p.heldAt != null);
}

/// Mirrors the API's `SettlementEntryResponseDto`. `role` is one of
/// `WINNER`/`LOSER`/`DRAW_PARTICIPANT`/`REFUND_RECIPIENT`/
/// `PLATFORM_FEE`.
class SettlementEntryInfo {
  const SettlementEntryInfo({
    required this.userId,
    required this.role,
    required this.availableDeltaMinor,
    required this.heldDeltaMinor,
  });

  factory SettlementEntryInfo.fromJson(Map<String, dynamic> json) {
    return SettlementEntryInfo(
      userId: json['userId'] as String,
      role: json['role'] as String,
      availableDeltaMinor: json['availableDeltaMinor'] as String,
      heldDeltaMinor: json['heldDeltaMinor'] as String,
    );
  }

  final String userId;
  final String role;
  final String availableDeltaMinor;
  final String heldDeltaMinor;
}

/// Mirrors the API's `SettlementResponseDto`. `outcome` is one of
/// `WIN`/`DRAW`/`REFUND`/`CANCELLED` (see
/// docs/decisions/ADR-017-deterministic-settlement.md).
class SettlementInfo {
  const SettlementInfo({
    required this.id,
    required this.outcome,
    required this.status,
    required this.currency,
    required this.poolAmountMinor,
    required this.platformFeeAmountMinor,
    required this.entries,
    required this.completedAt,
  });

  factory SettlementInfo.fromJson(Map<String, dynamic> json) {
    return SettlementInfo(
      id: json['id'] as String,
      outcome: json['outcome'] as String,
      status: json['status'] as String,
      currency: json['currency'] as String,
      poolAmountMinor: json['poolAmountMinor'] as String,
      platformFeeAmountMinor: json['platformFeeAmountMinor'] as String,
      entries: (json['entries'] as List<dynamic>)
          .cast<Map<String, dynamic>>()
          .map(SettlementEntryInfo.fromJson)
          .toList(),
      completedAt: json['completedAt'] == null
          ? null
          : DateTime.parse(json['completedAt'] as String),
    );
  }

  final String id;
  final String outcome;
  final String status;
  final String currency;
  final String poolAmountMinor;
  final String platformFeeAmountMinor;
  final List<SettlementEntryInfo> entries;
  final DateTime? completedAt;

  /// This user's own settlement row, if any (there is always exactly one
  /// per player — the platform-fee row belongs to the system account, so
  /// it's never returned here).
  SettlementEntryInfo? entryFor(String userId) {
    for (final entry in entries) {
      if (entry.userId == userId) return entry;
    }
    return null;
  }
}

/// Mirrors the API's `MatchFinancialResponseDto`. Both [stake] and
/// [settlement] are `null` for an ordinary free-play match — this is the
/// *only* signal the client needs to tell free play and staked play
/// apart (see ADR-016).
class MatchFinancialInfo {
  const MatchFinancialInfo({required this.stake, required this.settlement});

  /// The "nothing financial here" shape — used as the default before
  /// this has ever loaded, and is exactly what free play's own
  /// `GET /matches/:id/financial` response resolves to.
  const MatchFinancialInfo.empty() : stake = null, settlement = null;

  final MatchStakeInfo? stake;
  final SettlementInfo? settlement;

  factory MatchFinancialInfo.fromJson(Map<String, dynamic> json) {
    return MatchFinancialInfo(
      stake: json['stake'] == null
          ? null
          : MatchStakeInfo.fromJson(json['stake'] as Map<String, dynamic>),
      settlement: json['settlement'] == null
          ? null
          : SettlementInfo.fromJson(json['settlement'] as Map<String, dynamic>),
    );
  }

  bool get isFinanciallyBacked => stake != null;
}
