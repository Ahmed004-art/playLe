import 'package:flutter/foundation.dart';

import '../games/games_repository.dart';
import '../logging/app_logger.dart';
import 'match_history_state.dart';
import 'social_errors.dart';
import 'social_models.dart';
import 'social_repository.dart';

/// Owns the signed-in player's match history for one screen.
///
/// Uses only what the API already exposes: `GET /matches` (cursor-paged),
/// `GET /users/summaries` for opponent names - one request per page, never one
/// per match - and `GET /games` once for game names. Names the API will not
/// reveal (a blocked player, say) are shown as unavailable rather than
/// invented, and a failure to resolve names or games never fails the history
/// itself.
///
/// Like `PlayerProfileController` it never double-fetches (a request in flight
/// blocks another of the same kind) and drops any response that arrives after
/// [dispose].
class MatchHistoryController extends ChangeNotifier {
  MatchHistoryController(
    this._social,
    this._games, {
    required this.myUserId,
    this.pageSize = 20,
  });

  final SocialRepository _social;
  final GamesRepository _games;
  final String myUserId;
  final int pageSize;

  MatchHistoryState _state = const MatchHistoryLoading();
  MatchHistoryState get state => _state;

  final List<MatchHistoryEntry> _entries = [];
  String? _nextCursor;

  /// userId -> display name for players the API revealed.
  final Map<String, String> _names = {};

  /// userIds already asked about, whether or not the API revealed them, so a
  /// hidden player is not asked about again on every page.
  final Set<String> _askedAbout = {};

  Map<String, String>? _gameNames;
  bool _gamesRequested = false;

  bool _loadingFirstPage = false;
  bool _loadingMore = false;
  bool _disposed = false;

  /// Loads (or reloads) the first page.
  Future<void> load() async {
    if (_loadingFirstPage) {
      return;
    }
    _loadingFirstPage = true;
    _setState(const MatchHistoryLoading());
    try {
      final page = await _social.getMatchHistory(limit: pageSize);
      _entries
        ..clear()
        ..addAll(page.items);
      _nextCursor = page.nextCursor;
      await _resolveNames(page.items);
      await _resolveGameNames();
      _setState(_loaded());
    } catch (e) {
      AppLogger.instance.warning('Failed to load match history: $e');
      if (classifyFailure(e) == SocialFailureKind.unauthorized) {
        _setState(const MatchHistoryUnauthorized());
      } else {
        _setState(MatchHistoryError(friendlyFailureMessage(e)));
      }
    } finally {
      _loadingFirstPage = false;
    }
  }

  /// Loads the next page, if there is one. Does nothing while a page is
  /// already loading, before the first page has loaded, or on the last page.
  Future<void> loadMore() async {
    final cursor = _nextCursor;
    if (_loadingMore ||
        _loadingFirstPage ||
        cursor == null ||
        _state is! MatchHistoryLoaded) {
      return;
    }
    _loadingMore = true;
    _setState(_loaded(isLoadingMore: true));
    try {
      final page = await _social.getMatchHistory(
        cursor: cursor,
        limit: pageSize,
      );
      final known = _entries.map((e) => e.id).toSet();
      final fresh = page.items.where((e) => !known.contains(e.id)).toList();
      _entries.addAll(fresh);
      _nextCursor = page.nextCursor;
      await _resolveNames(fresh);
      _setState(_loaded());
    } catch (e) {
      AppLogger.instance.warning('Failed to load more match history: $e');
      if (classifyFailure(e) == SocialFailureKind.unauthorized) {
        _setState(const MatchHistoryUnauthorized());
      } else {
        _setState(_loaded(loadMoreError: friendlyFailureMessage(e)));
      }
    } finally {
      _loadingMore = false;
    }
  }

  MatchHistoryLoaded _loaded({
    bool isLoadingMore = false,
    String? loadMoreError,
  }) {
    return MatchHistoryLoaded(
      items: _entries.map(_toItem).toList(),
      hasMore: _nextCursor != null,
      isLoadingMore: isLoadingMore,
      loadMoreError: loadMoreError,
    );
  }

  MatchHistoryItem _toItem(MatchHistoryEntry entry) {
    final opponents = entry.playerUserIds
        .where((id) => id != myUserId)
        .toList();

    final String opponentLabel;
    String? opponentUserId;
    if (opponents.isEmpty) {
      opponentLabel = 'Unknown opponent';
    } else if (opponents.length == 1) {
      opponentUserId = opponents.first;
      opponentLabel = _names[opponents.first] ?? 'Player unavailable';
    } else {
      opponentLabel = '${opponents.length} opponents';
    }

    return MatchHistoryItem(
      entry: entry,
      result: describeMatchResult(entry, myUserId),
      gameLabel: _gameNames?[entry.gameId] ?? prettyGameName(entry.gameId),
      opponentLabel: opponentLabel,
      opponentUserId: opponentUserId,
    );
  }

  /// Resolves every opponent not yet asked about with ONE batch request.
  /// Best-effort: a failure leaves those players as "unavailable".
  Future<void> _resolveNames(List<MatchHistoryEntry> entries) async {
    final wanted = <String>{};
    for (final entry in entries) {
      for (final id in entry.playerUserIds) {
        if (id != myUserId && !_askedAbout.contains(id)) {
          wanted.add(id);
        }
      }
    }
    if (wanted.isEmpty) {
      return;
    }
    try {
      final summaries = await _social.getSummaries(wanted.toList());
      _askedAbout.addAll(wanted);
      for (final summary in summaries) {
        _names[summary.id] = summary.displayLabel;
      }
    } catch (e) {
      AppLogger.instance.warning('Failed to resolve opponent names: $e');
    }
  }

  /// Best-effort, once: a failure leaves the readable fallback names.
  Future<void> _resolveGameNames() async {
    if (_gamesRequested) {
      return;
    }
    _gamesRequested = true;
    try {
      final games = await _games.listGames();
      _gameNames = {for (final game in games) game.id: game.displayName};
    } catch (e) {
      AppLogger.instance.warning('Failed to load game names: $e');
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

  void _setState(MatchHistoryState next) {
    if (_disposed) {
      return;
    }
    _state = next;
    notifyListeners();
  }
}
