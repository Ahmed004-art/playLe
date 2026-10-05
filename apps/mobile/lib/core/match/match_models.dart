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
