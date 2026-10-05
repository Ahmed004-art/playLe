import 'package:flutter/foundation.dart';

import '../errors/app_exception.dart';
import '../logging/app_logger.dart';
import '../network/websocket_client.dart';
import '../realtime/realtime_connection_manager.dart';
import 'matchmaking_repository.dart';
import 'matchmaking_state.dart';

/// Owns the "Find Opponent" flow. [join]'s own REST response is only
/// provisional (see `MatchmakingRepository`) — the authoritative signal
/// that a match formed is the `match:found` push, which this listens for
/// regardless of what the REST call itself returned.
class MatchmakingController extends ChangeNotifier {
  MatchmakingController(
    this._repository,
    this._webSocketClient,
    this._realtimeConnectionManager,
  );

  final MatchmakingRepository _repository;
  final WebSocketClient _webSocketClient;
  final RealtimeConnectionManager _realtimeConnectionManager;

  MatchmakingState _state = const MatchmakingIdle();
  MatchmakingState get state => _state;

  String? _gameId;
  void Function()? _unsubscribeMatchFound;

  Future<void> join(String gameId) async {
    _gameId = gameId;
    _setState(const MatchmakingSearching());

    try {
      await _realtimeConnectionManager.connect();
      _unsubscribeMatchFound?.call();
      _unsubscribeMatchFound = _webSocketClient.on('match:found', (data) {
        if (data is Map &&
            data['gameId'] == _gameId &&
            data['matchId'] is String) {
          _setState(MatchmakingMatched(data['matchId'] as String));
        }
      });

      final result = await _repository.join(gameId);
      if (result.status == 'MATCHED' && result.matchId != null) {
        _setState(MatchmakingMatched(result.matchId!));
      }
      // Otherwise stay in Searching — the match:found push above resolves it.
    } catch (e) {
      AppLogger.instance.warning('Matchmaking join failed: $e');
      _setState(
        MatchmakingError(
          e is AppException ? e.message : 'Failed to join matchmaking',
        ),
      );
    }
  }

  Future<void> cancel() async {
    final gameId = _gameId;
    _unsubscribeMatchFound?.call();
    _unsubscribeMatchFound = null;
    _setState(const MatchmakingIdle());

    if (gameId != null) {
      try {
        await _repository.leave(gameId);
      } catch (e) {
        AppLogger.instance.warning('Matchmaking leave failed: $e');
      }
    }
  }

  @override
  void dispose() {
    _unsubscribeMatchFound?.call();
    super.dispose();
  }

  void _setState(MatchmakingState next) {
    _state = next;
    notifyListeners();
  }
}
