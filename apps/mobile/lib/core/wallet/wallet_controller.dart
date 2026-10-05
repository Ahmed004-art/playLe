import 'package:flutter/foundation.dart';

import '../errors/app_exception.dart';
import '../logging/app_logger.dart';
import 'wallet_models.dart';
import 'wallet_repository.dart';
import 'wallet_state.dart';

/// Owns wallet/financial UI state. Screens read [state] (via
/// `ListenableBuilder(listenable: sl<WalletController>(), ...)`) and call
/// [refresh]/[deposit]/[withdraw]/[cancelWithdrawal] — mirroring
/// `core/auth/auth_controller.dart`'s pattern exactly.
///
/// Deposit/withdrawal calls never swallow errors: the caller (a form
/// screen) must be able to show the real server-reported error (e.g.
/// "Minimum deposit is 500 minor units") rather than a generic failure.
class WalletController extends ChangeNotifier {
  WalletController(this._repository);

  final WalletRepository _repository;

  WalletState _state = const WalletLoading();
  WalletState get state => _state;

  Future<void> refresh() async {
    _setState(const WalletLoading());
    try {
      final wallet = await _repository.getWallet();
      final transactions = await _repository.getTransactions();
      _setState(WalletLoaded(wallet: wallet, transactions: transactions));
    } catch (e) {
      AppLogger.instance.warning('Failed to load wallet: $e');
      _setState(
        WalletLoadError(
          e is AppException ? e.message : 'Failed to load wallet',
        ),
      );
    }
  }

  Future<Deposit> deposit({required String amountMinor}) async {
    final result = await _repository.createDeposit(amountMinor: amountMinor);
    await refresh();
    return result;
  }

  Future<Withdrawal> withdraw({
    required String amountMinor,
    required Map<String, dynamic> destinationDetails,
  }) async {
    final result = await _repository.createWithdrawal(
      amountMinor: amountMinor,
      destinationDetails: destinationDetails,
    );
    await refresh();
    return result;
  }

  Future<Withdrawal> cancelWithdrawal(String id) async {
    final result = await _repository.cancelWithdrawal(id);
    await refresh();
    return result;
  }

  void _setState(WalletState next) {
    _state = next;
    notifyListeners();
  }
}
