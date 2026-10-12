import 'package:flutter/foundation.dart';

import '../errors/app_exception.dart';
import '../logging/app_logger.dart';
import 'responsible_gaming_repository.dart';
import 'responsible_gaming_state.dart';

/// Owns the authenticated user's responsible-gaming restriction status.
/// Mirrors `core/wallet/wallet_controller.dart`'s shape: every mutating
/// action refreshes [state] afterwards, and none of them swallow errors
/// — the caller must be able to show the real server-reported reason
/// (e.g. "Self-exclusion is already active").
class ResponsibleGamingController extends ChangeNotifier {
  ResponsibleGamingController(this._repository);

  final ResponsibleGamingRepository _repository;

  ResponsibleGamingState _state = const ResponsibleGamingLoading();
  ResponsibleGamingState get state => _state;

  Future<void> refresh() async {
    _setState(const ResponsibleGamingLoading());
    try {
      final restrictions = await _repository.getStatus();
      _setState(ResponsibleGamingLoaded(restrictions));
    } catch (e) {
      AppLogger.instance.warning(
        'Failed to load responsible-gaming status: $e',
      );
      _setState(
        ResponsibleGamingLoadError(
          e is AppException ? e.message : 'Failed to load status',
        ),
      );
    }
  }

  Future<void> selfExclude() async {
    await _repository.selfExclude();
    await refresh();
  }

  Future<void> startCoolingOff(int durationMinutes) async {
    await _repository.startCoolingOff(durationMinutes);
    await refresh();
  }

  Future<void> setDepositLimit(String limitMinor) async {
    await _repository.setDepositLimit(limitMinor);
    await refresh();
  }

  Future<void> setStakeLimit(String limitMinor) async {
    await _repository.setStakeLimit(limitMinor);
    await refresh();
  }

  Future<void> setLossLimit(String limitMinor) async {
    await _repository.setLossLimit(limitMinor);
    await refresh();
  }

  void _setState(ResponsibleGamingState next) {
    _state = next;
    notifyListeners();
  }
}
