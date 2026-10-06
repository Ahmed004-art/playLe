import 'package:flutter/foundation.dart';

import '../errors/app_exception.dart';
import '../logging/app_logger.dart';
import '../match_stakes/match_stake_models.dart';
import '../network/websocket_client.dart';
import '../realtime/realtime_connection_manager.dart';
import 'match_repository.dart';
import 'match_state.dart';

/// Owns one match's authoritative view. The server is the sole source
/// of truth for state/status/winner (see ADR-008) — this controller
/// never computes an outcome itself; it only ever displays whatever
/// `GET /matches/:id` (REST) or a `match:*` push tells it. A push is
/// treated purely as "something changed, re-fetch" rather than a
/// trusted payload to merge directly, keeping exactly one code path
/// that produces [MatchViewLoaded].
class MatchController extends ChangeNotifier {
  MatchController(
    this._repository,
    this._webSocketClient,
    this._realtimeConnectionManager,
  );

  final MatchRepository _repository;
  final WebSocketClient _webSocketClient;
  final RealtimeConnectionManager _realtimeConnectionManager;

  MatchViewState _state = const MatchViewLoading();
  MatchViewState get state => _state;

  String? _matchId;
  final List<void Function()> _unsubscribers = [];

  Future<void> loadMatch(String matchId) async {
    _matchId = matchId;
    _setState(const MatchViewLoading());
    try {
      final match = await _repository.getMatch(matchId);
      final financial = await _fetchFinancial(matchId);
      _setState(MatchViewLoaded(match, financial: financial));
      await _joinRealtimeRoom(matchId);
    } catch (e) {
      AppLogger.instance.warning('Failed to load match $matchId: $e');
      _setState(
        MatchViewError(e is AppException ? e.message : 'Failed to load match'),
      );
    }
  }

  Future<void> submitMove(Map<String, dynamic> payload) async {
    final matchId = _matchId;
    if (matchId == null) return;

    final result = await _repository.submitCommand(matchId, payload);
    final match = await _repository.getMatch(matchId);
    final financial = await _fetchFinancial(matchId);
    _setState(
      MatchViewLoaded(
        match,
        lastRejection: result.accepted ? null : result.rejectionReason,
        financial: financial,
      ),
    );
  }

  /// Confirms (holds) the current user's stake for this match — see
  /// `POST /matches/:id/stake/confirm`. A no-op if no match is loaded.
  /// Never swallows an error: the stake-confirmation screen must be able
  /// to show the real server-reported reason (e.g. insufficient
  /// balance), the same "never swallow a financial error" rule
  /// `core/wallet/wallet_controller.dart`'s deposit/withdraw follow.
  Future<void> confirmStake() async {
    final matchId = _matchId;
    if (matchId == null) return;
    await _repository.confirmStake(matchId);
    await _refreshFromPush();
  }

  Future<MatchFinancialInfo> _fetchFinancial(String matchId) async {
    try {
      return await _repository.getFinancial(matchId);
    } catch (e) {
      // Best-effort: a financial-info failure shouldn't block showing
      // the match itself — fall back to the free-play shape.
      AppLogger.instance.warning(
        'Failed to load financial info for match $matchId: $e',
      );
      return const MatchFinancialInfo.empty();
    }
  }

  Future<void> _joinRealtimeRoom(String matchId) async {
    await _realtimeConnectionManager.connect();
    _clearSubscriptions();

    for (final event in [
      'match:state',
      'match:completed',
      'player:left',
      'player:reconnected',
    ]) {
      _unsubscribers.add(
        _webSocketClient.on(event, (data) {
          if (data is Map && data['matchId'] == _matchId) {
            _refreshFromPush();
          }
        }),
      );
    }

    _webSocketClient.emit('match:join', {'matchId': matchId});
  }

  Future<void> _refreshFromPush() async {
    final matchId = _matchId;
    if (matchId == null) return;
    try {
      final match = await _repository.getMatch(matchId);
      final financial = await _fetchFinancial(matchId);
      _setState(MatchViewLoaded(match, financial: financial));
    } catch (e) {
      // Best-effort: keep showing the last known-good state rather than
      // erroring out mid-match over a transient refresh failure.
      AppLogger.instance.warning('Failed to refresh match $matchId: $e');
    }
  }

  void leaveRealtimeRoom() {
    _clearSubscriptions();
  }

  void _clearSubscriptions() {
    for (final unsubscribe in _unsubscribers) {
      unsubscribe();
    }
    _unsubscribers.clear();
  }

  @override
  void dispose() {
    _clearSubscriptions();
    super.dispose();
  }

  void _setState(MatchViewState next) {
    _state = next;
    notifyListeners();
  }
}
