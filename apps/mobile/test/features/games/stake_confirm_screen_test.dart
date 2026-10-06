import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/match/match_models.dart';
import 'package:playle_mobile/core/match_stakes/match_stake_models.dart';
import 'package:playle_mobile/core/wallet/wallet_controller.dart';
import 'package:playle_mobile/features/games/stake_confirm_screen.dart';

import '../../core/match/fake_match_repository.dart' show buildTestStake;
import '../../core/wallet/fake_wallet_repository.dart';

MatchInfo _waitingMatch() {
  return const MatchInfo(
    id: 'match-1',
    gameId: 'tic_tac_toe',
    status: 'WAITING',
    stateVersion: 0,
    state: {
      'board': [null, null, null, null, null, null, null, null, null],
      'playerOrder': ['user-1', 'user-2'],
      'moveCount': 0,
    },
    winnerUserId: null,
    resultIsDraw: false,
    players: [
      MatchPlayerInfo(userId: 'user-1', seat: 0, connected: true),
      MatchPlayerInfo(userId: 'user-2', seat: 1, connected: true),
    ],
  );
}

Widget _wrap({
  required MatchStakeInfo stake,
  required Future<void> Function() onConfirm,
  WalletController? walletController,
}) {
  return MaterialApp(
    home: StakeConfirmScreen(
      match: _waitingMatch(),
      stake: stake,
      currentUserId: 'user-1',
      walletController:
          walletController ?? WalletController(FakeWalletRepository()),
      onConfirm: onConfirm,
      onExit: () {},
    ),
  );
}

void main() {
  group('StakeConfirmScreen', () {
    testWidgets('shows entry, pool, platform fee, and potential win', (
      tester,
    ) async {
      final stake = buildTestStake(
        stakeAmountMinor: '1000',
        poolAmountMinor: '2000',
      );

      await tester.pumpWidget(_wrap(stake: stake, onConfirm: () async {}));
      await tester.pump();

      expect(find.textContaining('Le 10.00'), findsWidgets);
      expect(find.textContaining('Le 20.00'), findsOneWidget);
      expect(find.textContaining('Le 2.00'), findsOneWidget);
      expect(find.textContaining('Le 18.00'), findsOneWidget);
    });

    testWidgets('shows the wallet balance once it loads', (tester) async {
      final stake = buildTestStake();
      final wallet = WalletController(FakeWalletRepository());

      await tester.pumpWidget(
        _wrap(stake: stake, onConfirm: () async {}, walletController: wallet),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Le 100.00'), findsOneWidget);
    });

    testWidgets('tapping Confirm Entry calls onConfirm', (tester) async {
      var confirmed = false;
      final stake = buildTestStake();

      await tester.pumpWidget(
        _wrap(
          stake: stake,
          onConfirm: () async {
            confirmed = true;
          },
        ),
      );
      await tester.pump();

      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();

      expect(confirmed, isTrue);
    });

    testWidgets(
      'shows a waiting banner instead of the button once this player has already confirmed',
      (tester) async {
        final stake = buildTestStake(
          players: [
            MatchStakePlayerInfo(
              userId: 'user-1',
              heldAt: DateTime.utc(2026, 1, 1),
            ),
            const MatchStakePlayerInfo(userId: 'user-2', heldAt: null),
          ],
        );

        await tester.pumpWidget(_wrap(stake: stake, onConfirm: () async {}));
        await tester.pump();

        expect(
          find.text('Waiting for the other player to confirm…'),
          findsOneWidget,
        );
        expect(find.textContaining('Confirm Entry —'), findsNothing);
      },
    );

    testWidgets('shows the server-reported error when confirming fails', (
      tester,
    ) async {
      final stake = buildTestStake();

      await tester.pumpWidget(
        _wrap(
          stake: stake,
          onConfirm: () async {
            throw const NetworkException('Insufficient balance');
          },
        ),
      );
      await tester.pump();

      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();

      expect(find.text('Insufficient balance'), findsOneWidget);
    });
  });
}
