/// Mirrors the API's `DiceState`/`DiceRoll`/`DiceAttempt` (see
/// `apps/api/src/games/dice/dice.types.ts`). `Match.state` is opaque JSON
/// on the wire — this is the one place that parses it into a typed shape
/// for the Dice screen to render. Purely a client-side view: every field
/// mirrors a value the server already rolled and decided (see ADR-008 and
/// ADR-025) — nothing here generates or computes a roll or a result.
class DiceRollInfo {
  const DiceRollInfo({
    required this.userId,
    required this.dice,
    required this.total,
  });

  factory DiceRollInfo.fromJson(Map<String, dynamic> json) {
    final dice = (json['dice'] as List).cast<int>();
    return DiceRollInfo(
      userId: json['userId'] as String,
      dice: [dice[0], dice[1]],
      total: json['total'] as int,
    );
  }

  final String userId;
  final List<int> dice;
  final int total;
}

/// One completed attempt: both players rolled and the totals were
/// compared. A tied attempt replays the same [round].
class DiceAttemptInfo {
  const DiceAttemptInfo({
    required this.round,
    required this.rolls,
    required this.winnerUserId,
  });

  factory DiceAttemptInfo.fromJson(Map<String, dynamic> json) {
    final rolls = (json['rolls'] as List)
        .cast<Map<String, dynamic>>()
        .map(DiceRollInfo.fromJson)
        .toList();
    return DiceAttemptInfo(
      round: json['round'] as int,
      rolls: rolls,
      winnerUserId: json['winnerUserId'] as String?,
    );
  }

  final int round;
  final List<DiceRollInfo> rolls;
  final String? winnerUserId;

  bool get isTie => winnerUserId == null;
}

class DiceBoardState {
  const DiceBoardState({
    required this.playerOrder,
    required this.currentTurn,
    required this.round,
    required this.roundWins,
    required this.consecutiveTies,
    required this.pendingRoll,
    required this.attempts,
    required this.winnerUserId,
    required this.isDraw,
  });

  factory DiceBoardState.fromJson(Map<String, dynamic> json) {
    final playerOrder = (json['playerOrder'] as List).cast<String>();
    final roundWins = (json['roundWins'] as List).cast<int>();
    final pending = json['pendingRoll'] as Map<String, dynamic>?;
    final attempts = (json['attempts'] as List)
        .cast<Map<String, dynamic>>()
        .map(DiceAttemptInfo.fromJson)
        .toList();
    return DiceBoardState(
      playerOrder: [playerOrder[0], playerOrder[1]],
      currentTurn: json['currentTurn'] as String,
      round: json['round'] as int,
      roundWins: [roundWins[0], roundWins[1]],
      consecutiveTies: json['consecutiveTies'] as int,
      pendingRoll: pending == null ? null : DiceRollInfo.fromJson(pending),
      attempts: attempts,
      winnerUserId: json['winnerUserId'] as String?,
      isDraw: json['isDraw'] as bool,
    );
  }

  /// First player to win this many rounds wins the match (ADR-025).
  static const int roundsToWin = 2;

  final List<String> playerOrder;
  final String currentTurn;
  final int round;
  final List<int> roundWins;
  final int consecutiveTies;
  final DiceRollInfo? pendingRoll;
  final List<DiceAttemptInfo> attempts;
  final String? winnerUserId;
  final bool isDraw;

  int winsFor(String userId) {
    final index = playerOrder.indexOf(userId);
    return index < 0 ? 0 : roundWins[index];
  }

  DiceAttemptInfo? get lastAttempt => attempts.isEmpty ? null : attempts.last;
}
