import 'package:flutter/foundation.dart';

import '../errors/app_exception.dart';
import '../logging/app_logger.dart';
import 'mfa_models.dart';
import 'mfa_repository.dart';
import 'mfa_state.dart';

/// Owns the authenticated account's MFA-enabled status. Screens read
/// [state] (via `ListenableBuilder`) and call [enroll]/[confirm]/
/// [disable] directly — mirrors `core/wallet/wallet_controller.dart`'s
/// pattern. [enroll]/[confirm]/[disable] never swallow errors so the
/// calling screen can show the real server-reported reason (e.g. an
/// invalid code).
class MfaController extends ChangeNotifier {
  MfaController(this._repository);

  final MfaRepository _repository;

  MfaState _state = const MfaLoading();
  MfaState get state => _state;

  Future<void> refresh() async {
    _setState(const MfaLoading());
    try {
      final enabled = await _repository.getStatus();
      _setState(MfaLoaded(enabled));
    } catch (e) {
      AppLogger.instance.warning('Failed to load MFA status: $e');
      _setState(
        MfaLoadError(
          e is AppException ? e.message : 'Failed to load MFA status',
        ),
      );
    }
  }

  Future<MfaEnrollment> enroll() => _repository.enroll();

  Future<List<String>> confirm(String code) async {
    final codes = await _repository.confirm(code);
    await refresh();
    return codes;
  }

  Future<void> disable(String code) async {
    await _repository.disable(code);
    await refresh();
  }

  void _setState(MfaState next) {
    _state = next;
    notifyListeners();
  }
}
