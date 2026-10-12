import 'package:flutter/foundation.dart';

import '../errors/app_exception.dart';
import '../logging/app_logger.dart';
import 'sessions_repository.dart';
import 'sessions_state.dart';

/// Owns the authenticated user's own active-session list — mirrors
/// `core/disputes/disputes_controller.dart`'s shape (a list that only
/// changes in response to this user's own actions, no real-time push).
///
/// [revokeAll] intentionally does not log the user out itself — it only
/// ends sessions server-side. The caller (the sessions screen) is
/// responsible for also calling `AuthController.logout()` immediately
/// after, exactly like any other logout, since the current device's own
/// session is included in what just got revoked.
class SessionsController extends ChangeNotifier {
  SessionsController(this._repository);

  final SessionsRepository _repository;

  SessionsState _state = const SessionsLoading();
  SessionsState get state => _state;

  Future<void> refresh() async {
    _setState(const SessionsLoading());
    try {
      final sessions = await _repository.list();
      _setState(SessionsLoaded(sessions));
    } catch (e) {
      AppLogger.instance.warning('Failed to load sessions: $e');
      _setState(
        SessionsLoadError(
          e is AppException ? e.message : 'Failed to load sessions',
        ),
      );
    }
  }

  Future<void> revoke(String id) async {
    await _repository.revoke(id);
    await refresh();
  }

  Future<void> revokeAll() async {
    await _repository.revokeAll();
  }

  void _setState(SessionsState next) {
    _state = next;
    notifyListeners();
  }
}
