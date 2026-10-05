import 'dart:math';

import '../network/api_client.dart';
import 'wallet_models.dart';

/// Wallet/financial abstraction. The UI never talks to [ApiClient]
/// directly — only through this repository (see
/// `core/wallet/wallet_controller.dart`) — mirroring the
/// `core/auth/auth_repository.dart` pattern established in Phase 2.
abstract class WalletRepository {
  Future<Wallet> getWallet();

  Future<List<LedgerEntry>> getTransactions();

  Future<Deposit> createDeposit({required String amountMinor});

  Future<Withdrawal> createWithdrawal({
    required String amountMinor,
    required Map<String, dynamic> destinationDetails,
  });

  Future<Withdrawal> cancelWithdrawal(String id);
}

class HttpWalletRepository implements WalletRepository {
  const HttpWalletRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<Wallet> getWallet() async {
    final response = await apiClient.get<Map<String, dynamic>>('/wallet');
    return Wallet.fromJson(response.data!);
  }

  @override
  Future<List<LedgerEntry>> getTransactions() async {
    final response = await apiClient.get<Map<String, dynamic>>(
      '/wallet/transactions',
    );
    final items = response.data!['items'] as List<dynamic>;
    return items
        .cast<Map<String, dynamic>>()
        .map(LedgerEntry.fromJson)
        .toList();
  }

  @override
  Future<Deposit> createDeposit({required String amountMinor}) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/deposits',
      data: {'amountMinor': amountMinor},
      headers: {'Idempotency-Key': _generateIdempotencyKey()},
    );
    return Deposit.fromJson(response.data!);
  }

  @override
  Future<Withdrawal> createWithdrawal({
    required String amountMinor,
    required Map<String, dynamic> destinationDetails,
  }) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/withdrawals',
      data: {
        'amountMinor': amountMinor,
        'destinationDetails': destinationDetails,
      },
      headers: {'Idempotency-Key': _generateIdempotencyKey()},
    );
    return Withdrawal.fromJson(response.data!);
  }

  @override
  Future<Withdrawal> cancelWithdrawal(String id) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/withdrawals/$id/cancel',
    );
    return Withdrawal.fromJson(response.data!);
  }

  /// A fresh key per logical user action (e.g. one tap of "Deposit"), so a
  /// retried submission of the *same* action is safe to resend — the
  /// server returns the original result instead of creating a duplicate.
  /// Doesn't need to be cryptographically strong, just unique per attempt.
  String _generateIdempotencyKey() {
    final random = Random().nextInt(1 << 32).toRadixString(16);
    return '${DateTime.now().microsecondsSinceEpoch}-$random';
  }
}
