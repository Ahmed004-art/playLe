import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/match/match_models.dart';
import 'package:playle_mobile/core/match_stakes/match_stake_models.dart';
import 'package:playle_mobile/features/tic_tac_toe/tic_tac_toe_board.dart';
import 'package:playle_mobile/features/tic_tac_toe/tic_tac_toe_screen.dart';

import '../../core/match/fake_match_repository.dart'
    show buildTestStake, buildTestSettlement;

MatchInfo _match({
  String status = 'ACTIVE',
  int moveCount = 0,
  List<String?>? board,
  String? winnerUserId,
  bool resultIsDraw = false,
  bool opponentConnected = true,
  String? pendingDrawOfferByUserId,
  bool supportsResignation = true,
  bool supportsDraws = true,
  DateTime? turnDeadlineAt,
}) {
  return MatchInfo(
    id: 'match-1',
    gameId: 'tic_tac_toe',
    status: status,
    stateVersion: moveCount,
    state: {
      'board': board ?? List<String?>.filled(9, null),
      'playerOrder': ['user-1', 'user-2'],
      'moveCount': moveCount,
    },
    winnerUserId: winnerUserId,
    resultIsDraw: resultIsDraw,
    pendingDrawOfferByUserId: pendingDrawOfferByUserId,
    supportsResignation: supportsResignation,
    supportsDraws: supportsDraws,
    turnDeadlineAt: turnDeadlineAt,
    players: [
      const MatchPlayerInfo(userId: 'user-1', seat: 0, connected: true),
      MatchPlayerInfo(userId: 'user-2', seat: 1, connected: opponentConnected),
    ],
  );
}

Widget _wrap(
  MatchInfo match, {
  Future<void> Function(int)? onMove,
  MatchFinancialInfo financial = const MatchFinancialInfo.empty(),
  Future<void> Function(String)? onDispute,
  Future<void> Function()? onResign,
  Future<void> Function()? onOfferDraw,
  Future<void> Function()? onAcceptDraw,
  Future<void> Function()? onRejectDraw,
}) {
  return MaterialApp(
    home: TicTacToeScreen(
      match: match,
      currentUserId: 'user-1',
      lastRejection: null,
      onMove: onMove ?? (_) async {},
      onExit: () {},
      onResign: onResign ?? () async {},
      onOfferDraw: onOfferDraw ?? () async {},
      onAcceptDraw: onAcceptDraw ?? () async {},
      onRejectDraw: onRejectDraw ?? () async {},
      financial: financial,
      onDispute: onDispute,
    ),
  );
}

/// Scoped to `TicTacToeBoard`'s own cells — the action bar's "Resign"/
/// "Offer draw" buttons (Phase 9) also render an `InkWell` internally,
/// so an unscoped `find.byType(InkWell).at(n)` would hit those instead.
Finder _boardCell(int index) => find
    .descendant(of: find.byType(TicTacToeBoard), matching: find.byType(InkWell))
    .at(index);

void main() {
  group('TicTacToeScreen', () {
    testWidgets('shows "Your turn" when it is the current user\'s turn', (
      tester,
    ) async {
      await tester.pumpWidget(_wrap(_match(moveCount: 0)));
      expect(find.text('Your turn'), findsOneWidget);
    });

    testWidgets(
      'shows "Opponent\'s turn" when it is not the current user\'s turn',
      (tester) async {
        await tester.pumpWidget(_wrap(_match(moveCount: 1)));
        expect(find.text("Opponent's turn"), findsOneWidget);
      },
    );

    testWidgets(
      'tapping an empty cell on your turn calls onMove with the cell index',
      (tester) async {
        int? movedCell;
        await tester.pumpWidget(
          _wrap(
            _match(moveCount: 0),
            onMove: (cell) async {
              movedCell = cell;
            },
          ),
        );

        await tester.tap(_boardCell(0));
        await tester.pump();

        expect(movedCell, 0);
      },
    );

    testWidgets('shows a disconnected indicator when the opponent is offline', (
      tester,
    ) async {
      await tester.pumpWidget(_wrap(_match(opponentConnected: false)));
      expect(find.text('Opponent disconnected'), findsOneWidget);
    });

    testWidgets('shows a win banner when the current user is the winner', (
      tester,
    ) async {
      final board = List<String?>.filled(9, null);
      board[0] = board[1] = board[2] = 'user-1';
      await tester.pumpWidget(
        _wrap(
          _match(status: 'COMPLETED', board: board, winnerUserId: 'user-1'),
        ),
      );

      expect(find.textContaining('You won'), findsOneWidget);
    });

    testWidgets('shows a loss banner when the opponent is the winner', (
      tester,
    ) async {
      final board = List<String?>.filled(9, null);
      board[3] = board[4] = board[5] = 'user-2';
      await tester.pumpWidget(
        _wrap(
          _match(status: 'COMPLETED', board: board, winnerUserId: 'user-2'),
        ),
      );

      expect(find.text('You lost'), findsOneWidget);
    });

    testWidgets('shows a draw banner when the match ends in a draw', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(_match(status: 'COMPLETED', resultIsDraw: true)),
      );

      expect(find.text("It's a draw!"), findsOneWidget);
    });

    testWidgets('disables the board once the match is finished', (
      tester,
    ) async {
      int? movedCell;
      final board = List<String?>.filled(9, null);
      board[0] = board[1] = board[2] = 'user-1';
      await tester.pumpWidget(
        _wrap(
          _match(status: 'COMPLETED', board: board, winnerUserId: 'user-1'),
          onMove: (cell) async {
            movedCell = cell;
          },
        ),
      );

      await tester.tap(_boardCell(8));
      await tester.pump();

      expect(movedCell, isNull);
    });

    testWidgets(
      'free play (no financial info) shows no stake status bar and the plain result banner',
      (tester) async {
        await tester.pumpWidget(
          _wrap(_match(status: 'COMPLETED', winnerUserId: 'user-1')),
        );

        expect(find.textContaining('Entry '), findsNothing);
        expect(find.textContaining('Pool '), findsNothing);
        expect(find.text('You won! 🎉'), findsOneWidget);
        expect(find.text('Dispute'), findsNothing);
      },
    );

    testWidgets(
      'shows the stake status bar during an active financially-backed match',
      (tester) async {
        final stake = buildTestStake(
          stakeAmountMinor: '1000',
          poolAmountMinor: '2000',
        );
        await tester.pumpWidget(
          _wrap(
            _match(),
            financial: MatchFinancialInfo(stake: stake, settlement: null),
          ),
        );

        expect(find.textContaining('Entry Le 10.00'), findsOneWidget);
        expect(find.textContaining('Pool Le 20.00'), findsOneWidget);
      },
    );

    testWidgets('shows the financial win banner with prize pool and fee', (
      tester,
    ) async {
      final board = List<String?>.filled(9, null);
      board[0] = board[1] = board[2] = 'user-1';
      final settlement = buildTestSettlement(outcome: 'WIN');

      await tester.pumpWidget(
        _wrap(
          _match(status: 'COMPLETED', board: board, winnerUserId: 'user-1'),
          financial: MatchFinancialInfo(stake: null, settlement: settlement),
        ),
      );

      expect(find.text('You won! 🎉'), findsOneWidget);
      expect(find.textContaining('Prize pool Le 20.00'), findsOneWidget);
      expect(find.textContaining('Platform fee Le 2.00'), findsOneWidget);
      expect(find.textContaining('You received Le 18.00'), findsOneWidget);
    });

    testWidgets('shows the financial loss banner when the opponent won', (
      tester,
    ) async {
      final board = List<String?>.filled(9, null);
      board[3] = board[4] = board[5] = 'user-2';
      final settlement = buildTestSettlement(
        outcome: 'WIN',
        entries: const [
          SettlementEntryInfo(
            userId: 'user-2',
            role: 'WINNER',
            availableDeltaMinor: '1800',
            heldDeltaMinor: '-1000',
          ),
          SettlementEntryInfo(
            userId: 'user-1',
            role: 'LOSER',
            availableDeltaMinor: '0',
            heldDeltaMinor: '-1000',
          ),
        ],
      );

      await tester.pumpWidget(
        _wrap(
          _match(status: 'COMPLETED', board: board, winnerUserId: 'user-2'),
          financial: MatchFinancialInfo(stake: null, settlement: settlement),
        ),
      );

      expect(find.text('You lost'), findsOneWidget);
      expect(find.textContaining('prize pool'), findsOneWidget);
    });

    testWidgets('shows the financial draw banner with the refund amount', (
      tester,
    ) async {
      final settlement = buildTestSettlement(
        outcome: 'DRAW',
        entries: const [
          SettlementEntryInfo(
            userId: 'user-1',
            role: 'DRAW_PARTICIPANT',
            availableDeltaMinor: '1000',
            heldDeltaMinor: '-1000',
          ),
          SettlementEntryInfo(
            userId: 'user-2',
            role: 'DRAW_PARTICIPANT',
            availableDeltaMinor: '1000',
            heldDeltaMinor: '-1000',
          ),
        ],
      );

      await tester.pumpWidget(
        _wrap(
          _match(status: 'COMPLETED', resultIsDraw: true),
          financial: MatchFinancialInfo(stake: null, settlement: settlement),
        ),
      );

      expect(find.text("It's a draw!"), findsOneWidget);
      expect(
        find.textContaining('Le 10.00 was refunded in full'),
        findsOneWidget,
      );
    });

    testWidgets('shows the cancelled banner with the refund amount', (
      tester,
    ) async {
      final settlement = buildTestSettlement(
        outcome: 'CANCELLED',
        entries: const [
          SettlementEntryInfo(
            userId: 'user-1',
            role: 'REFUND_RECIPIENT',
            availableDeltaMinor: '1000',
            heldDeltaMinor: '-1000',
          ),
          SettlementEntryInfo(
            userId: 'user-2',
            role: 'REFUND_RECIPIENT',
            availableDeltaMinor: '1000',
            heldDeltaMinor: '-1000',
          ),
        ],
      );

      await tester.pumpWidget(
        _wrap(
          _match(status: 'ABANDONED'),
          financial: MatchFinancialInfo(stake: null, settlement: settlement),
        ),
      );

      expect(find.text('Match cancelled'), findsOneWidget);
      expect(find.textContaining('Le 10.00 was refunded'), findsOneWidget);
    });

    testWidgets(
      'filing a dispute from the financial result banner calls onDispute with the entered reason',
      (tester) async {
        String? capturedReason;
        final board = List<String?>.filled(9, null);
        board[0] = board[1] = board[2] = 'user-1';
        final settlement = buildTestSettlement(outcome: 'WIN');

        await tester.pumpWidget(
          _wrap(
            _match(status: 'COMPLETED', board: board, winnerUserId: 'user-1'),
            financial: MatchFinancialInfo(stake: null, settlement: settlement),
            onDispute: (reason) async {
              capturedReason = reason;
            },
          ),
        );

        await tester.tap(find.text('Dispute'));
        await tester.pumpAndSettle();

        // The submit button stays disabled until the reason is long enough.
        await tester.enterText(find.byType(TextField), 'too short');
        await tester.pump();
        expect(
          tester
              .widget<FilledButton>(find.widgetWithText(FilledButton, 'Submit'))
              .onPressed,
          isNull,
        );

        await tester.enterText(
          find.byType(TextField),
          'The opponent cheated by disconnecting on purpose.',
        );
        await tester.pump();
        await tester.tap(find.widgetWithText(FilledButton, 'Submit'));
        await tester.pumpAndSettle();

        expect(
          capturedReason,
          'The opponent cheated by disconnecting on purpose.',
        );
      },
    );

    group('resignation and draw offers (Phase 9)', () {
      testWidgets(
        'shows Resign/Offer draw while active, hides them once finished',
        (tester) async {
          await tester.pumpWidget(_wrap(_match()));
          expect(find.text('Resign'), findsOneWidget);
          expect(find.text('Offer draw'), findsOneWidget);

          await tester.pumpWidget(
            _wrap(_match(status: 'COMPLETED', winnerUserId: 'user-1')),
          );
          expect(find.text('Resign'), findsNothing);
          expect(find.text('Offer draw'), findsNothing);
        },
      );

      testWidgets('hides each action when the game does not support it', (
        tester,
      ) async {
        await tester.pumpWidget(
          _wrap(_match(supportsResignation: false, supportsDraws: false)),
        );
        expect(find.text('Resign'), findsNothing);
        expect(find.text('Offer draw'), findsNothing);
      });

      testWidgets('resigning requires confirmation before calling onResign', (
        tester,
      ) async {
        var resignCalled = false;
        await tester.pumpWidget(
          _wrap(
            _match(),
            onResign: () async {
              resignCalled = true;
            },
          ),
        );

        await tester.tap(find.text('Resign'));
        await tester.pumpAndSettle();
        expect(find.text('Resign this match?'), findsOneWidget);
        expect(resignCalled, isFalse);

        await tester.tap(find.widgetWithText(FilledButton, 'Resign'));
        await tester.pumpAndSettle();
        expect(resignCalled, isTrue);
      });

      testWidgets('cancelling the resign confirmation does not call onResign', (
        tester,
      ) async {
        var resignCalled = false;
        await tester.pumpWidget(
          _wrap(
            _match(),
            onResign: () async {
              resignCalled = true;
            },
          ),
        );

        await tester.tap(find.text('Resign'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Cancel'));
        await tester.pumpAndSettle();

        expect(resignCalled, isFalse);
      });

      testWidgets(
        'tapping Offer draw calls onOfferDraw directly, no confirmation',
        (tester) async {
          var offerCalled = false;
          await tester.pumpWidget(
            _wrap(
              _match(),
              onOfferDraw: () async {
                offerCalled = true;
              },
            ),
          );

          await tester.tap(find.text('Offer draw'));
          await tester.pump();
          expect(offerCalled, isTrue);
        },
      );

      testWidgets(
        "shows the opponent's offer with Accept/Decline, and Accept calls onAcceptDraw",
        (tester) async {
          var acceptCalled = false;
          await tester.pumpWidget(
            _wrap(
              _match(pendingDrawOfferByUserId: 'user-2'),
              onAcceptDraw: () async {
                acceptCalled = true;
              },
            ),
          );

          expect(find.text('Your opponent offered a draw'), findsOneWidget);
          expect(find.text('Accept'), findsOneWidget);
          expect(find.text('Decline'), findsOneWidget);
          // The action bar is replaced, not merely hidden, while an offer
          // is pending — there is nothing to "offer" again mid-offer.
          expect(find.text('Offer draw'), findsNothing);

          await tester.tap(find.text('Accept'));
          await tester.pump();
          expect(acceptCalled, isTrue);
        },
      );

      testWidgets(
        "shows the viewer's own pending offer with a Cancel action calling onRejectDraw",
        (tester) async {
          var rejectCalled = false;
          await tester.pumpWidget(
            _wrap(
              _match(pendingDrawOfferByUserId: 'user-1'),
              onRejectDraw: () async {
                rejectCalled = true;
              },
            ),
          );

          expect(
            find.text('Draw offer sent — waiting for your opponent'),
            findsOneWidget,
          );
          expect(find.text('Cancel'), findsOneWidget);

          await tester.tap(find.text('Cancel'));
          await tester.pump();
          expect(rejectCalled, isTrue);
        },
      );

      testWidgets('shows a live countdown next to the turn text', (
        tester,
      ) async {
        await tester.pumpWidget(
          _wrap(
            _match(
              turnDeadlineAt: DateTime.now().add(const Duration(seconds: 42)),
            ),
          ),
        );
        expect(find.textContaining('s left)'), findsOneWidget);
      });
    });
  });
}
