/// Mirrors the API's `MatchPlayerResponseDto`.
class MatchPlayerInfo {
  const MatchPlayerInfo({
    required this.userId,
    required this.seat,
    required this.connected,
  });

  factory MatchPlayerInfo.fromJson(Map<String, dynamic> json) {
    return MatchPlayerInfo(
      userId: json['userId'] as String,
      seat: json['seat'] as int,
      connected: json['connected'] as bool,
    );
  }

  final String userId;
  final int seat;
  final bool connected;
}

/// Mirrors the API's `MatchResponseDto`. `state` is intentionally
/// `Map<String, dynamic>` — opaque to the generic match layer, interpreted
/// only by the game-specific screen (e.g. `TicTacToeScreen`) that knows
/// its shape. See docs/decisions/ADR-015-game-module-architecture.md.
class MatchInfo {
  const MatchInfo({
    required this.id,
    required this.gameId,
    required this.status,
    required this.stateVersion,
    required this.state,
    required this.winnerUserId,
    required this.resultIsDraw,
    required this.players,
    this.terminationReason,
    this.turnDeadlineAt,
    this.pendingDrawOfferByUserId,
    this.supportsResignation = true,
    this.supportsDraws = true,
  });

  factory MatchInfo.fromJson(Map<String, dynamic> json) {
    return MatchInfo(
      id: json['id'] as String,
      gameId: json['gameId'] as String,
      status: json['status'] as String,
      stateVersion: json['stateVersion'] as int,
      state: Map<String, dynamic>.from(json['state'] as Map),
      winnerUserId: json['winnerUserId'] as String?,
      resultIsDraw: json['resultIsDraw'] as bool,
      terminationReason: json['terminationReason'] as String?,
      turnDeadlineAt: json['turnDeadlineAt'] == null
          ? null
          : DateTime.parse(json['turnDeadlineAt'] as String),
      pendingDrawOfferByUserId: json['pendingDrawOfferByUserId'] as String?,
      supportsResignation: json['supportsResignation'] as bool? ?? false,
      supportsDraws: json['supportsDraws'] as bool? ?? false,
      players: (json['players'] as List<dynamic>)
          .cast<Map<String, dynamic>>()
          .map(MatchPlayerInfo.fromJson)
          .toList(),
    );
  }

  final String id;
  final String gameId;
  final String status;
  final int stateVersion;
  final Map<String, dynamic> state;
  final String? winnerUserId;
  final bool resultIsDraw;

  /// Distinguishes *how* a terminal match ended — `null` means a normal
  /// game-rules win/draw. See
  /// docs/decisions/ADR-024-match-lifecycle-integrity.md.
  final String? terminationReason;

  /// The deadline for whoever currently holds the turn to move.
  /// Display-only — the server is the sole arbiter of expiry.
  final DateTime? turnDeadlineAt;

  /// The userId of whoever currently has an open draw offer, if any.
  final String? pendingDrawOfferByUserId;
  final bool supportsResignation;
  final bool supportsDraws;
  final List<MatchPlayerInfo> players;

  bool get isFinished =>
      status == 'COMPLETED' || status == 'ABANDONED' || status == 'CANCELLED';
}

class CommandResult {
  const CommandResult({
    required this.resultStatus,
    required this.rejectionReason,
  });

  factory CommandResult.fromJson(Map<String, dynamic> json) {
    return CommandResult(
      resultStatus: json['resultStatus'] as String,
      rejectionReason: json['rejectionReason'] as String?,
    );
  }

  final String resultStatus;
  final String? rejectionReason;

  bool get accepted => resultStatus == 'ACCEPTED';
}
