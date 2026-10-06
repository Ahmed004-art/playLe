import 'package:flutter/foundation.dart';

import '../errors/app_exception.dart';
import '../logging/app_logger.dart';
import '../match_stakes/match_stake_models.dart';
import '../network/websocket_client.dart';
import '../realtime/realtime_connection_manager.dart';
import 'challenge_models.dart';
import 'challenges_repository.dart';
import 'challenges_state.dart';

/// Owns the sent/received challenge list. A `challenge:received` or
/// `challenge:resolved` push is treated purely as "something changed,
/// re-fetch the list" — the same pattern as `MatchController`.
class ChallengesController extends ChangeNotifier {
  ChallengesController(
    this._repository,
    this._webSocketClient,
    this._realtimeConnectionManager,
  );

  final ChallengesRepository _repository;
  final WebSocketClient _webSocketClient;
  final RealtimeConnectionManager _realtimeConnectionManager;

  ChallengesState _state = const ChallengesLoading();
  ChallengesState get state => _state;

  final List<void Function()> _unsubscribers = [];
  bool _subscribed = false;

  Future<void> refresh() async {
    _setState(const ChallengesLoading());
    try {
      final challenges = await _repository.list();
      _setState(ChallengesLoaded(challenges));
      await _ensureSubscribed();
    } catch (e) {
      AppLogger.instance.warning('Failed to load challenges: $e');
      _setState(
        ChallengesLoadError(
          e is AppException ? e.message : 'Failed to load challenges',
        ),
      );
    }
  }

  /// Returns the created [ChallengeInfo]. Throws [AppException] (e.g.
  /// "No account with that username") if the username doesn't resolve —
  /// the caller shows that message directly.
  Future<ChallengeInfo> challengeByUsername(
    String gameId,
    String username, {
    MatchStakeRequest? stake,
  }) async {
    final opponentUserId = await _repository.lookupUserIdByUsername(username);
    final challenge = await _repository.create(
      gameId,
      opponentUserId,
      stake: stake,
    );
    await refresh();
    return challenge;
  }

  Future<void> accept(String challengeId) async {
    await _repository.accept(challengeId);
    await refresh();
  }

  Future<void> decline(String challengeId) async {
    await _repository.decline(challengeId);
    await refresh();
  }

  Future<void> cancel(String challengeId) async {
    await _repository.cancel(challengeId);
    await refresh();
  }

  Future<void> _ensureSubscribed() async {
    if (_subscribed) return;
    _subscribed = true;
    await _realtimeConnectionManager.connect();

    for (final event in ['challenge:received', 'challenge:resolved']) {
      _unsubscribers.add(_webSocketClient.on(event, (_) => refresh()));
    }
  }

  @override
  void dispose() {
    for (final unsubscribe in _unsubscribers) {
      unsubscribe();
    }
    super.dispose();
  }

  void _setState(ChallengesState next) {
    _state = next;
    notifyListeners();
  }
}
