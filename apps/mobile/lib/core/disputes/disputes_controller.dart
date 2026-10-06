import 'package:flutter/foundation.dart';

import '../errors/app_exception.dart';
import '../logging/app_logger.dart';
import 'dispute_models.dart';
import 'disputes_repository.dart';
import 'disputes_state.dart';

/// Owns the authenticated user's own dispute list. There is no
/// dispute-specific real-time push in this phase (see
/// docs/api/README.md's "Match Stakes, Settlement & Disputes Endpoints"
/// section) — the list only ever changes in response to this user's own
/// [create] call, so unlike `ChallengesController`/`MatchController` it
/// needs no WebSocket subscription at all.
class DisputesController extends ChangeNotifier {
  DisputesController(this._repository);

  final DisputesRepository _repository;

  DisputesState _state = const DisputesLoading();
  DisputesState get state => _state;

  Future<void> refresh() async {
    _setState(const DisputesLoading());
    try {
      final disputes = await _repository.list();
      _setState(DisputesLoaded(disputes));
    } catch (e) {
      AppLogger.instance.warning('Failed to load disputes: $e');
      _setState(
        DisputesLoadError(
          e is AppException ? e.message : 'Failed to load disputes',
        ),
      );
    }
  }

  /// Files a dispute, then refreshes the list. Never swallows an error —
  /// the caller (the result-banner dialog or the disputes screen) must
  /// be able to show the real server-reported reason (e.g. "Reason must
  /// be at least 10 characters").
  Future<DisputeInfo> create(String matchId, String reason) async {
    final dispute = await _repository.create(matchId, reason);
    await refresh();
    return dispute;
  }

  void _setState(DisputesState next) {
    _state = next;
    notifyListeners();
  }
}
