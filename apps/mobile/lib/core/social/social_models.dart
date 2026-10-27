// Typed, defensively-parsed mirrors of the API's public player data
// (Phase 12 - see docs/decisions/ADR-026-social-foundation.md).
//
// Every `fromJson` here reads an explicit allow-list of keys and throws a
// FormatException on a missing or wrongly-typed required field, instead of
// casting blindly or inventing a default. In particular a statistic is never
// defaulted to zero: a profile with a missing count is a contract violation
// and is reported as an error, not shown as "0 wins". Anything else the
// server might send (it should not send private fields at all) is ignored,
// so it cannot reach the UI.

String _requireString(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is String && value.isNotEmpty) {
    return value;
  }
  throw FormatException('Expected a non-empty string for "$key"');
}

String? _optionalString(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value == null) {
    return null;
  }
  if (value is String) {
    return value;
  }
  throw FormatException('Expected a string or null for "$key"');
}

int _requireCount(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is int && value >= 0) {
    return value;
  }
  if (value is num &&
      value.isFinite &&
      value >= 0 &&
      value == value.truncate()) {
    return value.toInt();
  }
  throw FormatException('Expected a non-negative whole number for "$key"');
}

bool _requireBool(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is bool) {
    return value;
  }
  throw FormatException('Expected a boolean for "$key"');
}

DateTime _requireDate(Map<String, dynamic> json, String key) {
  final parsed = _optionalDate(json, key);
  if (parsed == null) {
    throw FormatException('Expected a date for "$key"');
  }
  return parsed;
}

DateTime? _optionalDate(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value == null) {
    return null;
  }
  if (value is String) {
    final parsed = DateTime.tryParse(value);
    if (parsed != null) {
      return parsed;
    }
  }
  throw FormatException('Expected an ISO date or null for "$key"');
}

List<Map<String, dynamic>> _requireObjectList(
  Map<String, dynamic> json,
  String key,
) {
  final value = json[key];
  if (value is! List) {
    throw FormatException('Expected a list for "$key"');
  }
  final result = <Map<String, dynamic>>[];
  for (final item in value) {
    if (item is Map) {
      result.add(Map<String, dynamic>.from(item));
    } else {
      throw FormatException('Expected an object inside "$key"');
    }
  }
  return result;
}

final RegExp _uuidPattern = RegExp(
  r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
);

/// Whether [value] looks like a user id (the API's ids are UUIDs). Used to
/// reject a hand-edited or stale route id before making a request for it.
bool isValidUserId(String value) => _uuidPattern.hasMatch(value);

/// Mirrors `PlayerProfileResponseDto`: the only public profile data there is.
/// There is deliberately no email, phone, date of birth, role, status,
/// wallet, stake or avatar field - the server does not send them and this app
/// must not ask for them.
class PlayerProfile {
  const PlayerProfile({
    required this.id,
    required this.username,
    required this.displayName,
    required this.gamesPlayed,
    required this.wins,
    required this.losses,
    required this.draws,
  });

  factory PlayerProfile.fromJson(Map<String, dynamic> json) {
    return PlayerProfile(
      id: _requireString(json, 'id'),
      username: _requireString(json, 'username'),
      displayName: _optionalString(json, 'displayName'),
      gamesPlayed: _requireCount(json, 'gamesPlayed'),
      wins: _requireCount(json, 'wins'),
      losses: _requireCount(json, 'losses'),
      draws: _requireCount(json, 'draws'),
    );
  }

  final String id;
  final String username;
  final String? displayName;
  final int gamesPlayed;
  final int wins;
  final int losses;
  final int draws;

  /// The name to show: the display name when one is set (and not blank),
  /// otherwise the username.
  String get displayLabel => playerDisplayLabel(displayName, username);
}

/// Mirrors `PlayerSummaryResponseDto`: id, username and display name only.
class PlayerSummary {
  const PlayerSummary({
    required this.id,
    required this.username,
    required this.displayName,
  });

  factory PlayerSummary.fromJson(Map<String, dynamic> json) {
    return PlayerSummary(
      id: _requireString(json, 'id'),
      username: _requireString(json, 'username'),
      displayName: _optionalString(json, 'displayName'),
    );
  }

  final String id;
  final String username;
  final String? displayName;

  String get displayLabel => playerDisplayLabel(displayName, username);
}

/// The display name when set and not blank, otherwise the username.
String playerDisplayLabel(String? displayName, String username) {
  final name = displayName;
  if (name != null && name.trim().isNotEmpty) {
    return name.trim();
  }
  return username;
}

/// The subset of the API's `MatchResponseDto` the history list needs. The
/// opaque game `state` is deliberately not parsed (it is large, game-specific
/// and irrelevant here), and nothing about stakes or money exists in this
/// contract at all.
class MatchHistoryEntry {
  const MatchHistoryEntry({
    required this.id,
    required this.gameId,
    required this.status,
    required this.winnerUserId,
    required this.resultIsDraw,
    required this.terminationReason,
    required this.playerUserIds,
    required this.createdAt,
    required this.completedAt,
  });

  factory MatchHistoryEntry.fromJson(Map<String, dynamic> json) {
    final players = _requireObjectList(json, 'players');
    return MatchHistoryEntry(
      id: _requireString(json, 'id'),
      gameId: _requireString(json, 'gameId'),
      status: _requireString(json, 'status'),
      winnerUserId: _optionalString(json, 'winnerUserId'),
      resultIsDraw: _requireBool(json, 'resultIsDraw'),
      terminationReason: _optionalString(json, 'terminationReason'),
      playerUserIds: players.map((p) => _requireString(p, 'userId')).toList(),
      createdAt: _requireDate(json, 'createdAt'),
      completedAt: _optionalDate(json, 'completedAt'),
    );
  }

  final String id;
  final String gameId;

  /// `WAITING`, `READY`, `ACTIVE`, `COMPLETED`, `CANCELLED`, `EXPIRED` or
  /// `ABANDONED`.
  final String status;
  final String? winnerUserId;
  final bool resultIsDraw;

  /// How a finished match ended (`RESIGNATION`, `TURN_TIMEOUT`,
  /// `DRAW_AGREED`, `ABANDONED_DISCONNECT`, `WAITING_TIMEOUT`,
  /// `CANCELLED_BY_PLAYER`), or `null` for an ordinary game result.
  final String? terminationReason;
  final List<String> playerUserIds;
  final DateTime createdAt;
  final DateTime? completedAt;

  /// When the match finished, or when it was created if it has not.
  DateTime get when => completedAt ?? createdAt;
}

/// One page of `GET /matches`. [nextCursor] is `null` on the last page.
class MatchHistoryPage {
  const MatchHistoryPage({required this.items, required this.nextCursor});

  factory MatchHistoryPage.fromJson(Map<String, dynamic> json) {
    return MatchHistoryPage(
      items: _requireObjectList(
        json,
        'items',
      ).map(MatchHistoryEntry.fromJson).toList(),
      nextCursor: _optionalString(json, 'nextCursor'),
    );
  }

  final List<MatchHistoryEntry> items;
  final String? nextCursor;
}

/// How a match in the history should be presented to the viewer.
enum MatchOutcome {
  won,
  lost,
  draw,
  abandoned,
  cancelled,
  inProgress,
  unrecorded,
}

class MatchResultView {
  const MatchResultView(this.outcome, this.label, [this.detail]);

  final MatchOutcome outcome;

  /// Short headline: "Won", "Lost", "Draw", "Abandoned", ...
  final String label;

  /// An optional explanation of how it ended, e.g. "Opponent resigned".
  final String? detail;
}

/// Maps a stored match to how the viewer should see it, by the same rules the
/// server uses for profile statistics (ADR-026, "Match statistics"):
///
/// - Only a `COMPLETED` match with a consistent stored result is a win, loss
///   or draw. A win or loss needs `resultIsDraw == false` and a winner who is
///   one of the match's players; a draw needs `resultIsDraw == true` and no
///   winner. A completed match that is neither is shown as "Result not
///   recorded" rather than guessed at.
/// - An `ABANDONED` match (a player disconnected) is shown as abandoned even
///   when the server recorded a winner for it: a win or loss is never
///   inferred from a disconnect.
/// - `CANCELLED`/`EXPIRED` are cancelled; `WAITING`/`READY`/`ACTIVE` are not
///   finished yet.
MatchResultView describeMatchResult(MatchHistoryEntry match, String myUserId) {
  switch (match.status) {
    case 'COMPLETED':
      return _describeCompleted(match, myUserId);
    case 'ABANDONED':
      return const MatchResultView(
        MatchOutcome.abandoned,
        'Abandoned',
        'A player disconnected.',
      );
    case 'CANCELLED':
    case 'EXPIRED':
      return MatchResultView(
        MatchOutcome.cancelled,
        'Cancelled',
        match.terminationReason == 'WAITING_TIMEOUT'
            ? 'The match never started.'
            : null,
      );
    case 'WAITING':
      return const MatchResultView(MatchOutcome.inProgress, 'Waiting to start');
    case 'READY':
    case 'ACTIVE':
      return const MatchResultView(MatchOutcome.inProgress, 'In progress');
    default:
      return const MatchResultView(MatchOutcome.unrecorded, 'Unknown');
  }
}

MatchResultView _describeCompleted(MatchHistoryEntry match, String myUserId) {
  const unrecorded = MatchResultView(
    MatchOutcome.unrecorded,
    'Result not recorded',
  );
  if (!match.playerUserIds.contains(myUserId)) {
    return unrecorded;
  }

  final winner = match.winnerUserId;
  if (match.resultIsDraw) {
    if (winner != null) {
      return unrecorded;
    }
    return MatchResultView(
      MatchOutcome.draw,
      'Draw',
      match.terminationReason == 'DRAW_AGREED' ? 'Draw agreed.' : null,
    );
  }

  if (winner == null || !match.playerUserIds.contains(winner)) {
    return unrecorded;
  }

  if (winner == myUserId) {
    String? detail;
    if (match.terminationReason == 'RESIGNATION') {
      detail = 'Opponent resigned.';
    } else if (match.terminationReason == 'TURN_TIMEOUT') {
      detail = 'Opponent ran out of time.';
    }
    return MatchResultView(MatchOutcome.won, 'Won', detail);
  }

  String? detail;
  if (match.terminationReason == 'RESIGNATION') {
    detail = 'You resigned.';
  } else if (match.terminationReason == 'TURN_TIMEOUT') {
    detail = 'You ran out of time.';
  }
  return MatchResultView(MatchOutcome.lost, 'Lost', detail);
}

/// A readable fallback for a game id the catalog did not name:
/// `tic_tac_toe` becomes "Tic Tac Toe".
String prettyGameName(String gameId) {
  final words = gameId
      .split('_')
      .where((w) => w.isNotEmpty)
      .map((w) => '${w[0].toUpperCase()}${w.substring(1)}')
      .toList();
  return words.isEmpty ? gameId : words.join(' ');
}

const List<String> _monthNames = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// "26 Oct 2026", from the date parts of [date] as given - call it with a
/// local time (`date.toLocal()`) to show the viewer's own day.
String formatShortDate(DateTime date) {
  return '${date.day} ${_monthNames[date.month - 1]} ${date.year}';
}

// ---------------------------------------------------------------------------
// Friends, friend requests and blocks (Phase 12 PR 5). Mirrors the DTOs in
// apps/api/src/friends/dto/friends.dto.ts and apps/api/src/blocks/dto.
// ---------------------------------------------------------------------------

Map<String, dynamic> _requireObject(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is Map) {
    return Map<String, dynamic>.from(value);
  }
  throw FormatException('Expected an object for "$key"');
}

/// One page of any cursor-paged list: `{ items, nextCursor }`. `nextCursor` is
/// `null` on the last page.
class SocialPage<T> {
  const SocialPage({required this.items, required this.nextCursor});

  /// Parses a page, parsing every item with [parseItem].
  static SocialPage<T> parse<T>(
    Map<String, dynamic> json,
    T Function(Map<String, dynamic> item) parseItem,
  ) {
    return SocialPage<T>(
      items: _requireObjectList(json, 'items').map(parseItem).toList(),
      nextCursor: _optionalString(json, 'nextCursor'),
    );
  }

  final List<T> items;
  final String? nextCursor;
}

/// A friend's best-effort presence. The server only reports presence for a
/// player's own friends, and reports `OFFLINE` when it does not know. An
/// unrecognised value is treated as offline rather than shown as online.
enum FriendPresence {
  online,
  inMatch,
  searching,
  offline;

  static FriendPresence parse(String? value) {
    switch (value) {
      case 'ONLINE':
        return FriendPresence.online;
      case 'IN_MATCH':
        return FriendPresence.inMatch;
      case 'SEARCHING':
        return FriendPresence.searching;
      default:
        return FriendPresence.offline;
    }
  }

  String get label {
    switch (this) {
      case FriendPresence.online:
        return 'Online';
      case FriendPresence.inMatch:
        return 'In a match';
      case FriendPresence.searching:
        return 'Looking for a match';
      case FriendPresence.offline:
        return 'Offline';
    }
  }
}

/// Mirrors `FriendResponseDto`: a friend and their presence.
class FriendInfo {
  const FriendInfo({
    required this.userId,
    required this.username,
    required this.displayName,
    required this.presence,
    required this.friendsSince,
  });

  factory FriendInfo.fromJson(Map<String, dynamic> json) {
    return FriendInfo(
      userId: _requireString(json, 'userId'),
      username: _requireString(json, 'username'),
      displayName: _optionalString(json, 'displayName'),
      // Best-effort: a missing or oddly-typed presence is offline, and never
      // fails the whole friend.
      presence: FriendPresence.parse(
        json['presence'] is String ? json['presence'] as String : null,
      ),
      friendsSince: _requireDate(json, 'friendsSince'),
    );
  }

  final String userId;
  final String username;
  final String? displayName;
  final FriendPresence presence;
  final DateTime friendsSince;

  String get displayLabel => playerDisplayLabel(displayName, username);
}

enum FriendRequestDirection {
  incoming,
  outgoing;

  /// The value of the API's `direction` query parameter.
  String get apiValue => name;
}

/// Mirrors `FriendRequestResponseDto`. [direction] is relative to the signed-in
/// player and [player] is the *other* player in the request.
class FriendRequestInfo {
  const FriendRequestInfo({
    required this.id,
    required this.status,
    required this.direction,
    required this.player,
    required this.createdAt,
    required this.respondedAt,
  });

  factory FriendRequestInfo.fromJson(Map<String, dynamic> json) {
    final direction = _requireString(json, 'direction');
    return FriendRequestInfo(
      id: _requireString(json, 'id'),
      status: _requireString(json, 'status'),
      direction: switch (direction) {
        'INCOMING' => FriendRequestDirection.incoming,
        'OUTGOING' => FriendRequestDirection.outgoing,
        _ => throw FormatException('Unknown request direction "$direction"'),
      },
      player: PlayerSummary.fromJson(_requireObject(json, 'player')),
      createdAt: _requireDate(json, 'createdAt'),
      respondedAt: _optionalDate(json, 'respondedAt'),
    );
  }

  final String id;

  /// `PENDING`, `ACCEPTED`, `DECLINED` or `CANCELLED`. Sending a request to
  /// someone who had already asked you accepts theirs instead, so a freshly
  /// sent request can come back `ACCEPTED`.
  final String status;
  final FriendRequestDirection direction;
  final PlayerSummary player;
  final DateTime createdAt;
  final DateTime? respondedAt;

  bool get isPending => status == 'PENDING';
  bool get isAccepted => status == 'ACCEPTED';
}

/// Mirrors the blocks API's `BlockResponseDto`: a player the signed-in player
/// has blocked. The API never reveals who has blocked *them*.
class BlockedPlayer {
  const BlockedPlayer({
    required this.userId,
    required this.username,
    required this.displayName,
    required this.blockedAt,
  });

  factory BlockedPlayer.fromJson(Map<String, dynamic> json) {
    return BlockedPlayer(
      userId: _requireString(json, 'userId'),
      username: _requireString(json, 'username'),
      displayName: _optionalString(json, 'displayName'),
      blockedAt: _requireDate(json, 'blockedAt'),
    );
  }

  final String userId;
  final String username;
  final String? displayName;
  final DateTime blockedAt;

  String get displayLabel => playerDisplayLabel(displayName, username);
}

/// Mirrors `UserLookupResponseDto`: `GET /users/lookup?username=`. A player who
/// does not exist and one who has blocked the caller are indistinguishable
/// (both 404), by design.
class PlayerLookupResult {
  const PlayerLookupResult({required this.id, required this.username});

  factory PlayerLookupResult.fromJson(Map<String, dynamic> json) {
    return PlayerLookupResult(
      id: _requireString(json, 'id'),
      username: _requireString(json, 'username'),
    );
  }

  final String id;
  final String username;
}
