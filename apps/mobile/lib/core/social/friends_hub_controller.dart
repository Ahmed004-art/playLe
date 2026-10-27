import 'package:flutter/foundation.dart';

import '../challenges/challenge_models.dart';
import '../errors/app_exception.dart';
import '../games/game_models.dart';
import '../games/games_repository.dart';
import '../logging/app_logger.dart';
import '../network/websocket_client.dart';
import '../realtime/realtime_connection_manager.dart';
import 'paged_list_controller.dart';
import 'social_errors.dart';
import 'social_models.dart';
import 'social_repository.dart';

/// The result of a user action (send, accept, block, challenge, ...). The UI
/// shows [SocialActionSuccess] only after the server confirmed the change.
sealed class SocialActionResult {
  const SocialActionResult();
}

class SocialActionSuccess extends SocialActionResult {
  const SocialActionSuccess(this.message);
  final String message;
}

class SocialActionFailure extends SocialActionResult {
  const SocialActionFailure(this.message, {this.sessionExpired = false});

  final String message;

  /// The failure was a 401: the session is no longer valid.
  final bool sessionExpired;
}

/// The same action was already in progress, so this tap did nothing.
class SocialActionBusy extends SocialActionResult {
  const SocialActionBusy();
}

sealed class LookupOutcome {
  const LookupOutcome();
}

class LookupFound extends LookupOutcome {
  const LookupFound(this.player);
  final PlayerLookupResult player;
}

/// No such player - or one who has blocked you; the API cannot say which.
class LookupNotFound extends LookupOutcome {
  const LookupNotFound();
}

class LookupIsSelf extends LookupOutcome {
  const LookupIsSelf();
}

class LookupFailed extends LookupOutcome {
  const LookupFailed(this.message, {this.sessionExpired = false});

  final String message;
  final bool sessionExpired;
}

class LookupBusy extends LookupOutcome {
  const LookupBusy();
}

/// How another player relates to the signed-in player, as far as the loaded
/// lists show.
enum PlayerRelation { none, friend, requestSent, requestReceived, blocked }

/// The games a challenge can be sent for, or why they could not be loaded.
class GamesLoadResult {
  const GamesLoadResult({
    this.games = const [],
    this.error,
    this.sessionExpired = false,
  });

  final List<GameInfo> games;
  final String? error;
  final bool sessionExpired;
}

/// Creates a free-play challenge to [opponentUserId] for [gameId] through the
/// app's existing challenge flow (`ChallengesController.challengeByUserId`).
typedef CreateChallenge =
    Future<ChallengeInfo> Function(String gameId, String opponentUserId);

/// Owns the signed-in player's friends, friend requests (incoming and sent),
/// blocked players and the actions on them, for one Friends screen.
///
/// - Every list is a [PagedListController] (loading / error / retry / paging).
/// - **The UI changes only on a confirmed server response.** An action is sent,
///   and only if the server accepts it is anything updated - and then the
///   affected lists are re-fetched from the server rather than patched by
///   guesswork. Unblocking in particular restores nothing locally: the server
///   does not bring back a friendship or request, so neither does the app.
/// - **No duplicate submissions:** an action on a request or a player is
///   ignored while one is already in flight for it ([isRequestBusy],
///   [isPlayerBusy]).
/// - **Realtime is a hint, not a mutation:** `friend:request-received` and
///   `friend:request-accepted` only trigger a re-fetch. Listeners are added
///   once and removed in [dispose].
/// - Challenges are free play only, to a friend, through the existing
///   challenge flow; the server's block and availability rules are the
///   authority and their messages are shown as they are.
class FriendsHubController extends ChangeNotifier {
  FriendsHubController({
    required this._social,
    required this._games,
    required this._createChallenge,
    required this._webSocketClient,
    required RealtimeConnectionManager realtimeConnectionManager,
    required this.myUserId,
    int pageSize = 20,
  }) : _realtime = realtimeConnectionManager {
    friends = PagedListController<FriendInfo>(
      fetchPage: (cursor, limit) =>
          _social.getFriends(cursor: cursor, limit: limit),
      idOf: (f) => f.userId,
      pageSize: pageSize,
    );
    incoming = PagedListController<FriendRequestInfo>(
      fetchPage: (cursor, limit) => _social.getFriendRequests(
        FriendRequestDirection.incoming,
        cursor: cursor,
        limit: limit,
      ),
      idOf: (r) => r.id,
      pageSize: pageSize,
    );
    outgoing = PagedListController<FriendRequestInfo>(
      fetchPage: (cursor, limit) => _social.getFriendRequests(
        FriendRequestDirection.outgoing,
        cursor: cursor,
        limit: limit,
      ),
      idOf: (r) => r.id,
      pageSize: pageSize,
    );
    blocked = PagedListController<BlockedPlayer>(
      fetchPage: (cursor, limit) =>
          _social.getBlocks(cursor: cursor, limit: limit),
      idOf: (b) => b.userId,
      pageSize: pageSize,
    );
  }

  final SocialRepository _social;
  final GamesRepository _games;
  final CreateChallenge _createChallenge;
  final WebSocketClient _webSocketClient;
  final RealtimeConnectionManager _realtime;
  final String myUserId;

  late final PagedListController<FriendInfo> friends;
  late final PagedListController<FriendRequestInfo> incoming;
  late final PagedListController<FriendRequestInfo> outgoing;
  late final PagedListController<BlockedPlayer> blocked;

  /// All four lists, for a screen that wants one thing to listen to.
  late final Listenable lists = Listenable.merge([
    this,
    friends,
    incoming,
    outgoing,
    blocked,
  ]);

  final Set<String> _busy = {};
  final List<void Function()> _unsubscribers = [];
  bool _started = false;
  bool _disposed = false;
  List<GameInfo>? _loadedGames;

  bool isRequestBusy(String requestId) => _busy.contains('request:$requestId');
  bool isPlayerBusy(String userId) => _busy.contains('player:$userId');
  bool get isLookingUp => _busy.contains('lookup');

  /// Loads every list and starts listening for realtime hints. Safe to call
  /// more than once.
  Future<void> start() async {
    if (_started) {
      return;
    }
    _started = true;
    await Future.wait([
      friends.load(),
      incoming.load(),
      outgoing.load(),
      blocked.load(),
    ]);
    await _subscribeToRealtime();
  }

  /// Re-fetches every list from the server.
  Future<void> refreshAll() => Future.wait([
    friends.reload(),
    incoming.reload(),
    outgoing.reload(),
    blocked.reload(),
  ]);

  // ---- realtime -----------------------------------------------------------

  Future<void> _subscribeToRealtime() async {
    if (_disposed) {
      return;
    }
    try {
      await _realtime.connect();
    } catch (e) {
      AppLogger.instance.warning('Realtime connect failed: $e');
    }
    if (_disposed) {
      return;
    }
    // A pushed event only says "something changed": the server is asked
    // what, and the lists show what it answers.
    _unsubscribers
      ..add(
        _webSocketClient.on(
          'friend:request-received',
          (_) => incoming.reload(),
        ),
      )
      ..add(
        _webSocketClient.on('friend:request-accepted', (_) {
          outgoing.reload();
          friends.reload();
        }),
      );
  }

  // ---- what is already known ----------------------------------------------

  List<T> _itemsOf<T>(PagedListController<T> list) {
    final state = list.state;
    return state is PagedListLoaded<T> ? state.items : <T>[];
  }

  /// How [userId] relates to the signed-in player, **from the pages loaded so
  /// far** (a hint for the UI, never a decision: the server still has the last
  /// word on every action).
  PlayerRelation relationTo(String userId) {
    if (_itemsOf(blocked).any((b) => b.userId == userId)) {
      return PlayerRelation.blocked;
    }
    if (_itemsOf(friends).any((f) => f.userId == userId)) {
      return PlayerRelation.friend;
    }
    if (incomingRequestFrom(userId) != null) {
      return PlayerRelation.requestReceived;
    }
    if (_itemsOf(outgoing).any((r) => r.player.id == userId)) {
      return PlayerRelation.requestSent;
    }
    return PlayerRelation.none;
  }

  /// The loaded incoming request from [userId], if any.
  FriendRequestInfo? incomingRequestFrom(String userId) {
    for (final request in _itemsOf(incoming)) {
      if (request.player.id == userId) {
        return request;
      }
    }
    return null;
  }

  /// The loaded blocked-player entry for [userId], if any.
  BlockedPlayer? blockedEntryFor(String userId) {
    for (final entry in _itemsOf(blocked)) {
      if (entry.userId == userId) {
        return entry;
      }
    }
    return null;
  }

  // ---- actions ------------------------------------------------------------

  /// Sends a friend request to [userId]. The server may instead *accept* a
  /// request that player had already sent you; the message says which.
  Future<SocialActionResult> sendFriendRequest(
    String userId,
    String displayName,
  ) {
    return _runPlayerAction(userId, () async {
      final request = await _social.sendFriendRequest(userId);
      await Future.wait([outgoing.reload(), incoming.reload()]);
      if (request.isAccepted) {
        await friends.reload();
        return 'You and $displayName are now friends.';
      }
      return 'Friend request sent to $displayName.';
    });
  }

  Future<SocialActionResult> acceptRequest(FriendRequestInfo request) {
    return _runRequestAction(request.id, () async {
      await _social.acceptFriendRequest(request.id);
      incoming.removeWhere((r) => r.id == request.id);
      await Future.wait([friends.reload(), incoming.reload()]);
      return 'You and ${request.player.displayLabel} are now friends.';
    }, reconcile: incoming.reload);
  }

  Future<SocialActionResult> declineRequest(FriendRequestInfo request) {
    return _runRequestAction(request.id, () async {
      await _social.declineFriendRequest(request.id);
      incoming.removeWhere((r) => r.id == request.id);
      await incoming.reload();
      return 'Request from ${request.player.displayLabel} declined.';
    }, reconcile: incoming.reload);
  }

  Future<SocialActionResult> cancelRequest(FriendRequestInfo request) {
    return _runRequestAction(request.id, () async {
      await _social.cancelFriendRequest(request.id);
      outgoing.removeWhere((r) => r.id == request.id);
      await outgoing.reload();
      return 'Request to ${request.player.displayLabel} cancelled.';
    }, reconcile: outgoing.reload);
  }

  Future<SocialActionResult> removeFriend(FriendInfo friend) {
    return _runPlayerAction(friend.userId, () async {
      await _social.removeFriend(friend.userId);
      friends.removeWhere((f) => f.userId == friend.userId);
      await friends.reload();
      return '${friend.displayLabel} removed from your friends.';
    });
  }

  /// Blocks a player. The server also removes any friendship and cancels any
  /// pending request or challenge between you, so every list is re-fetched.
  Future<SocialActionResult> blockPlayer(String userId, String displayName) {
    return _runPlayerAction(userId, () async {
      await _social.blockPlayer(userId);
      await Future.wait([
        blocked.reload(),
        friends.reload(),
        incoming.reload(),
        outgoing.reload(),
      ]);
      return '$displayName is blocked.';
    });
  }

  /// Unblocks a player. This restores **nothing**: the server does not bring
  /// back a friendship or a request, so only the blocked list is refreshed.
  Future<SocialActionResult> unblockPlayer(BlockedPlayer player) {
    return _runPlayerAction(player.userId, () async {
      await _social.unblockPlayer(player.userId);
      blocked.removeWhere((b) => b.userId == player.userId);
      await blocked.reload();
      return '${player.displayLabel} is unblocked. Friendships and requests '
          'are not restored.';
    });
  }

  /// Looks a player up by exact username (the API's block-aware lookup).
  Future<LookupOutcome> lookup(String rawUsername) async {
    final username = rawUsername.trim().replaceFirst(RegExp(r'^@'), '');
    if (username.isEmpty) {
      return const LookupNotFound();
    }
    if (_busy.contains('lookup')) {
      return const LookupBusy();
    }
    _busy.add('lookup');
    _notify();
    try {
      final player = await _social.lookupPlayer(username);
      if (player.id == myUserId) {
        return const LookupIsSelf();
      }
      return LookupFound(player);
    } catch (e) {
      switch (classifyFailure(e)) {
        case SocialFailureKind.notFound:
          return const LookupNotFound();
        case SocialFailureKind.unauthorized:
          return const LookupFailed(
            _sessionExpiredMessage,
            sessionExpired: true,
          );
        case SocialFailureKind.other:
          return LookupFailed(friendlyFailureMessage(e));
      }
    } finally {
      _busy.remove('lookup');
      _notify();
    }
  }

  /// The games a challenge can be sent for (loaded once, then reused).
  Future<GamesLoadResult> loadGames() async {
    final cached = _loadedGames;
    if (cached != null) {
      return GamesLoadResult(games: cached);
    }
    try {
      final games = await _games.listGames();
      _loadedGames = games;
      return GamesLoadResult(games: games);
    } catch (e) {
      if (classifyFailure(e) == SocialFailureKind.unauthorized) {
        return const GamesLoadResult(
          error: _sessionExpiredMessage,
          sessionExpired: true,
        );
      }
      return GamesLoadResult(error: friendlyFailureMessage(e));
    }
  }

  /// Sends [friend] a free-play challenge for [game] through the existing
  /// challenge flow. The server decides whether it is allowed (blocks, an
  /// unavailable player, a match already in progress, a duplicate challenge)
  /// and its reason is shown as it is.
  Future<SocialActionResult> challengeFriend(FriendInfo friend, GameInfo game) {
    return _runPlayerAction(friend.userId, () async {
      await _createChallenge(game.id, friend.userId);
      return 'Challenge sent to ${friend.displayLabel} for ${game.displayName}. '
          'They can accept it from that game\'s lobby.';
    }, failureMessage: _challengeFailureMessage);
  }

  static const String _sessionExpiredMessage =
      'Your session has expired. Please sign in again.';

  String _challengeFailureMessage(Object error) {
    if (error is NetworkException && error.statusCode == 404) {
      return 'That player is unavailable right now.';
    }
    return friendlyFailureMessage(error);
  }

  // ---- plumbing -----------------------------------------------------------

  /// A request action that fails (typically because the request was already
  /// resolved elsewhere) re-fetches [reconcile]'s list, so the screen stops
  /// showing something the server no longer has.
  Future<SocialActionResult> _runRequestAction(
    String requestId,
    Future<String> Function() action, {
    required Future<void> Function() reconcile,
  }) => _run('request:$requestId', action, onFailure: reconcile);

  Future<SocialActionResult> _runPlayerAction(
    String userId,
    Future<String> Function() action, {
    String Function(Object error)? failureMessage,
  }) => _run('player:$userId', action, failureMessage: failureMessage);

  Future<SocialActionResult> _run(
    String key,
    Future<String> Function() action, {
    String Function(Object error)? failureMessage,
    Future<void> Function()? onFailure,
  }) async {
    if (_busy.contains(key)) {
      return const SocialActionBusy();
    }
    _busy.add(key);
    _notify();
    try {
      return SocialActionSuccess(await action());
    } catch (e) {
      AppLogger.instance.warning('Social action failed: $e');
      if (classifyFailure(e) == SocialFailureKind.unauthorized) {
        return const SocialActionFailure(
          _sessionExpiredMessage,
          sessionExpired: true,
        );
      }
      final message = failureMessage != null
          ? failureMessage(e)
          : friendlyFailureMessage(e);
      await onFailure?.call();
      return SocialActionFailure(message);
    } finally {
      _busy.remove(key);
      _notify();
    }
  }

  void _notify() {
    if (!_disposed) {
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    for (final unsubscribe in _unsubscribers) {
      unsubscribe();
    }
    _unsubscribers.clear();
    friends.dispose();
    incoming.dispose();
    outgoing.dispose();
    blocked.dispose();
    super.dispose();
  }
}
