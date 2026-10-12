import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/match/match_models.dart';
import 'package:playle_mobile/core/match_stakes/match_stake_models.dart';
import 'package:playle_mobile/features/checkers/checkers_models.dart';
import 'package:playle_mobile/features/checkers/checkers_screen.dart';

import '../../core/match/fake_match_repository.dart'
    show buildTestStake, buildTestSettlement;

List<List<Map<String, dynamic>?>> _emptyBoard() =>
    List.generate(8, (_) => List<Map<String, dynamic>?>.filled(8, null));

Map<String, dynamic> _piece(String owner, {bool king = false}) => {
  'owner': owner,
  'king': king,
};

MatchInfo _match({
  String status = 'ACTIVE',
  List<List<Map<String, dynamic>?>>? board,
  String currentTurn = 'user-1',
  Map<String, dynamic>? mustContinueFrom,
  String? winnerUserId,
  bool resultIsDraw = false,
  bool opponentConnected = true,
}) {
  return MatchInfo(
    id: 'match-1',
    gameId: 'checkers',
    status: status,
    stateVersion: 1,
    state: {
      'board': board ?? _emptyBoard(),
      'playerOrder': ['user-1', 'user-2'],
      'currentTurn': currentTurn,
      'mustContinueFrom': mustContinueFrom,
      'movesSinceProgress': 0,
    },
    winnerUserId: winnerUserId,
    resultIsDraw: resultIsDraw,
    players: [
      const MatchPlayerInfo(userId: 'user-1', seat: 0, connected: true),
      MatchPlayerInfo(userId: 'user-2', seat: 1, connected: opponentConnected),
    ],
  );
}

Widget _wrap(
  MatchInfo match, {
  Future<void> Function(Coord, Coord)? onMove,
  MatchFinancialInfo financial = const MatchFinancialInfo.empty(),
  Future<void> Function(String)? onDispute,
}) {
  return MaterialApp(
    home: CheckersScreen(
      match: match,
      currentUserId: 'user-1',
      lastRejection: null,
      onMove: onMove ?? (_, _) async {},
      onExit: () {},
      financial: financial,
      onDispute: onDispute,
    ),
  );
}

void main() {
  group('CheckersScreen', () {
    testWidgets('shows "Your turn" when it is the current user\'s turn', (
      tester,
    ) async {
      await tester.pumpWidget(_wrap(_match(currentTurn: 'user-1')));
      expect(find.text('Your turn'), findsOneWidget);
    });

    testWidgets(
      'shows "Opponent\'s turn" when it is not the current user\'s turn',
      (tester) async {
        await tester.pumpWidget(_wrap(_match(currentTurn: 'user-2')));
        expect(find.text("Opponent's turn"), findsOneWidget);
      },
    );

    testWidgets('shows a disconnected indicator when the opponent is offline', (
      tester,
    ) async {
      await tester.pumpWidget(_wrap(_match(opponentConnected: false)));
      expect(find.text('Opponent disconnected'), findsOneWidget);
    });

    testWidgets(
      'selecting a piece then tapping a destination submits the move',
      (tester) async {
        Coord? from;
        Coord? to;
        final board = _emptyBoard();
        board[2][1] = _piece('user-1');
        await tester.pumpWidget(
          _wrap(
            _match(board: board, currentTurn: 'user-1'),
            onMove: (f, t) async {
              from = f;
              to = t;
            },
          ),
        );

        await tester.tap(find.byKey(const ValueKey('square-2-1')));
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('square-3-0')));
        await tester.pump();

        expect(from, const Coord(2, 1));
        expect(to, const Coord(3, 0));
      },
    );

    testWidgets('shows continuation guidance during a forced multi-jump', (
      tester,
    ) async {
      final board = _emptyBoard();
      board[4][3] = _piece('user-1');
      await tester.pumpWidget(
        _wrap(
          _match(
            board: board,
            currentTurn: 'user-1',
            mustContinueFrom: {'row': 4, 'col': 3},
          ),
        ),
      );

      expect(find.textContaining('Continue your jump'), findsOneWidget);
    });

    testWidgets(
      'a forced continuation move only accepts the forced piece as the origin',
      (tester) async {
        var calls = 0;
        final board = _emptyBoard();
        board[4][3] = _piece('user-1');
        await tester.pumpWidget(
          _wrap(
            _match(
              board: board,
              currentTurn: 'user-1',
              mustContinueFrom: {'row': 4, 'col': 3},
            ),
            onMove: (_, _) async {
              calls++;
            },
          ),
        );

        // Tapping the forced piece's own square is a no-op (nothing to
        // submit yet), then tapping a destination submits from the
        // forced square automatically.
        await tester.tap(find.byKey(const ValueKey('square-4-3')));
        await tester.pump();
        expect(calls, 0);

        await tester.tap(find.byKey(const ValueKey('square-5-4')));
        await tester.pump();
        expect(calls, 1);
      },
    );

    testWidgets('disables the board once the match is finished', (
      tester,
    ) async {
      var calls = 0;
      final board = _emptyBoard();
      board[2][1] = _piece('user-1');
      await tester.pumpWidget(
        _wrap(
          _match(status: 'COMPLETED', board: board, winnerUserId: 'user-1'),
          onMove: (_, _) async {
            calls++;
          },
        ),
      );

      await tester.tap(find.byKey(const ValueKey('square-2-1')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('square-3-0')));
      await tester.pump();

      expect(calls, 0);
    });

    testWidgets('shows a win banner when the current user is the winner', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(_match(status: 'COMPLETED', winnerUserId: 'user-1')),
      );
      expect(find.textContaining('You won'), findsOneWidget);
    });

    testWidgets('shows a draw banner when the match ends in a draw', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(_match(status: 'COMPLETED', resultIsDraw: true)),
      );
      expect(find.text("It's a draw!"), findsOneWidget);
    });

    testWidgets('free play (no financial info) shows no stake status bar', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(_match(status: 'COMPLETED', winnerUserId: 'user-1')),
      );
      expect(find.textContaining('Entry '), findsNothing);
      expect(find.textContaining('Pool '), findsNothing);
    });

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
      final settlement = buildTestSettlement(outcome: 'WIN');
      await tester.pumpWidget(
        _wrap(
          _match(status: 'COMPLETED', winnerUserId: 'user-1'),
          financial: MatchFinancialInfo(stake: null, settlement: settlement),
        ),
      );

      expect(find.text('You won! 🎉'), findsOneWidget);
      expect(find.textContaining('Prize pool Le 20.00'), findsOneWidget);
    });

    testWidgets(
      'filing a dispute from the financial result banner calls onDispute with the entered reason',
      (tester) async {
        String? capturedReason;
        final settlement = buildTestSettlement(outcome: 'WIN');

        await tester.pumpWidget(
          _wrap(
            _match(status: 'COMPLETED', winnerUserId: 'user-1'),
            financial: MatchFinancialInfo(stake: null, settlement: settlement),
            onDispute: (reason) async {
              capturedReason = reason;
            },
          ),
        );

        await tester.tap(find.text('Dispute'));
        await tester.pumpAndSettle();
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
  });
}
