import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/wallet/wallet_controller.dart';
import 'package:playle_mobile/core/wallet/wallet_models.dart';
import 'package:playle_mobile/core/wallet/wallet_state.dart';

import 'fake_wallet_repository.dart';

void main() {
  group('WalletController', () {
    test('starts in WalletLoading before refresh is called', () {
      final controller = WalletController(FakeWalletRepository());
      expect(controller.state, isA<WalletLoading>());
    });

    test('refresh loads the wallet and transactions', () async {
      final repo = FakeWalletRepository()
        ..walletToReturn = testWallet
        ..transactionsToReturn = [
          LedgerEntry(
            id: 'entry-1',
            type: 'DEPOSIT',
            availableDeltaMinor: '5000',
            heldDeltaMinor: '0',
            currency: 'SLE',
            createdAt: DateTime.now(),
          ),
        ];
      final controller = WalletController(repo);

      await controller.refresh();

      final state = controller.state;
      expect(state, isA<WalletLoaded>());
      final loaded = state as WalletLoaded;
      expect(loaded.wallet.availableBalanceMinor, '10000');
      expect(loaded.transactions, hasLength(1));
    });

    test('refresh surfaces an error as WalletLoadError', () async {
      final repo = FakeWalletRepository()
        ..nextError = const NetworkException('Server unreachable');
      final controller = WalletController(repo);

      await controller.refresh();

      final state = controller.state;
      expect(state, isA<WalletLoadError>());
      expect((state as WalletLoadError).message, 'Server unreachable');
    });

    test('deposit creates a deposit and refreshes the wallet', () async {
      final repo = FakeWalletRepository();
      final controller = WalletController(repo);

      final deposit = await controller.deposit(amountMinor: '5000');

      expect(deposit.amountMinor, '5000');
      expect(repo.lastDeposit, isNotNull);
      expect(controller.state, isA<WalletLoaded>());
    });

    test('withdraw creates a withdrawal and refreshes the wallet', () async {
      final repo = FakeWalletRepository();
      final controller = WalletController(repo);

      final withdrawal = await controller.withdraw(
        amountMinor: '2000',
        destinationDetails: {'method': 'ORANGE_MONEY'},
      );

      expect(withdrawal.amountMinor, '2000');
      expect(repo.lastWithdrawal, isNotNull);
      expect(controller.state, isA<WalletLoaded>());
    });

    test('cancelWithdrawal cancels and refreshes the wallet', () async {
      final repo = FakeWalletRepository();
      final controller = WalletController(repo);

      final result = await controller.cancelWithdrawal('withdrawal-1');

      expect(result.status, 'CANCELLED');
      expect(controller.state, isA<WalletLoaded>());
    });

    test('deposit rethrows the underlying error without swallowing it', () {
      final repo = FakeWalletRepository()
        ..nextError = const NetworkException(
          'Minimum deposit is 500 minor units',
        );
      final controller = WalletController(repo);

      expect(
        () => controller.deposit(amountMinor: '10'),
        throwsA(isA<NetworkException>()),
      );
    });
  });
}
