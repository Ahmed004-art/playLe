import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/wallet/wallet_controller.dart';
import 'package:playle_mobile/core/wallet/wallet_models.dart';
import 'package:playle_mobile/features/wallet/deposit_screen.dart';

import '../../core/wallet/fake_wallet_repository.dart';

Widget _wrap(WalletController controller) {
  return MaterialApp(home: DepositScreen(walletController: controller));
}

void main() {
  group('DepositScreen payment instructions', () {
    testWidgets('shows the USSD code and expiry prominently when the deposit '
        'response includes paymentInstructions', (tester) async {
      final repo = FakeWalletRepository();
      final controller = WalletController(repo);
      repo.lastDeposit = Deposit(
        id: 'deposit-1',
        amountMinor: '5000',
        currency: 'SLE',
        status: 'PENDING',
        provider: 'MONIME',
        createdAt: DateTime.now(),
        paymentInstructions: DepositPaymentInstructions(
          ussdCode: '*123*456#',
          expiresAt: DateTime.utc(2026, 1, 1, 12, 0, 0),
        ),
      );
      // createDeposit ignores the configured return and builds its own
      // 'PENDING' deposit from lastDeposit/the fallback — set the same
      // instructions on the object it will actually hand back.
      repo.depositToReturnFromGet = repo.lastDeposit;

      await tester.pumpWidget(_wrap(controller));
      await tester.enterText(find.byType(TextFormField), '50');
      await tester.tap(find.widgetWithText(FilledButton, 'Deposit'));
      await tester.pump();
      await tester.pump();

      expect(find.text('*123*456#'), findsOneWidget);
      expect(find.textContaining('Dial this code'), findsOneWidget);
      expect(
        find.textContaining('PlayLe does not complete this payment'),
        findsOneWidget,
      );
      expect(find.text('Pending'), findsOneWidget);

      // Unmount to cancel the polling timer this screen started, so no
      // Timer is left pending once the test ends.
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('shows an Expired badge for an EXPIRED deposit', (
      tester,
    ) async {
      final repo = FakeWalletRepository();
      final controller = WalletController(repo);
      repo.lastDeposit = Deposit(
        id: 'deposit-2',
        amountMinor: '5000',
        currency: 'SLE',
        status: 'EXPIRED',
        provider: 'MONIME',
        createdAt: DateTime.now(),
      );

      await tester.pumpWidget(_wrap(controller));
      await tester.enterText(find.byType(TextFormField), '50');
      await tester.tap(find.widgetWithText(FilledButton, 'Deposit'));
      await tester.pumpAndSettle();

      expect(find.text('Expired'), findsOneWidget);
      expect(find.textContaining('expired before it was used'), findsOneWidget);
    });

    testWidgets('does not show USSD instructions for a MANUAL deposit', (
      tester,
    ) async {
      final repo = FakeWalletRepository();
      final controller = WalletController(repo);
      repo.lastDeposit = Deposit(
        id: 'deposit-3',
        amountMinor: '5000',
        currency: 'SLE',
        status: 'PENDING',
        provider: 'MANUAL',
        createdAt: DateTime.now(),
      );
      repo.depositToReturnFromGet = repo.lastDeposit;

      await tester.pumpWidget(_wrap(controller));
      await tester.enterText(find.byType(TextFormField), '50');
      await tester.tap(find.widgetWithText(FilledButton, 'Deposit'));
      await tester.pump();
      await tester.pump();

      expect(find.textContaining('Dial this code'), findsNothing);

      await tester.pumpWidget(const SizedBox());
    });
  });
}
