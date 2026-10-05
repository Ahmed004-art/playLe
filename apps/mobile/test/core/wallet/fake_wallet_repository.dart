import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/wallet/wallet_models.dart';
import 'package:playle_mobile/core/wallet/wallet_repository.dart';

final testWallet = Wallet(
  availableBalanceMinor: '10000',
  heldBalanceMinor: '0',
  totalBalanceMinor: '10000',
  currency: 'SLE',
);

/// A controllable [WalletRepository] fake for testing [WalletController]
/// and wallet screens/routing without a real network dependency —
/// mirrors `test/core/auth/fake_auth_repository.dart`.
class FakeWalletRepository implements WalletRepository {
  Wallet walletToReturn = testWallet;
  List<LedgerEntry> transactionsToReturn = const [];
  AppException? nextError;
  Deposit? lastDeposit;
  Withdrawal? lastWithdrawal;

  @override
  Future<Wallet> getWallet() async {
    if (nextError != null) throw nextError!;
    return walletToReturn;
  }

  @override
  Future<List<LedgerEntry>> getTransactions() async {
    if (nextError != null) throw nextError!;
    return transactionsToReturn;
  }

  @override
  Future<Deposit> createDeposit({required String amountMinor}) async {
    if (nextError != null) throw nextError!;
    lastDeposit = Deposit(
      id: 'deposit-1',
      amountMinor: amountMinor,
      currency: 'SLE',
      status: 'PENDING',
      provider: 'MANUAL',
      createdAt: DateTime.now(),
    );
    return lastDeposit!;
  }

  @override
  Future<Withdrawal> createWithdrawal({
    required String amountMinor,
    required Map<String, dynamic> destinationDetails,
  }) async {
    if (nextError != null) throw nextError!;
    lastWithdrawal = Withdrawal(
      id: 'withdrawal-1',
      amountMinor: amountMinor,
      currency: 'SLE',
      status: 'PENDING_REVIEW',
      createdAt: DateTime.now(),
    );
    return lastWithdrawal!;
  }

  @override
  Future<Withdrawal> cancelWithdrawal(String id) async {
    if (nextError != null) throw nextError!;
    lastWithdrawal = Withdrawal(
      id: id,
      amountMinor: '0',
      currency: 'SLE',
      status: 'CANCELLED',
      createdAt: DateTime.now(),
    );
    return lastWithdrawal!;
  }
}
