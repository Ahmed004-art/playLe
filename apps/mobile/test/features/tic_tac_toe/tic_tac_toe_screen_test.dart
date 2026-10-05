import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/match/match_models.dart';
import 'package:playle_mobile/features/tic_tac_toe/tic_tac_toe_screen.dart';

MatchInfo _match({
  String status = 'ACTIVE',
  int moveCount = 0,
  List<String?>? board,
  String? winnerUserId,
  bool resultIsDraw = false,
  bool opponentConnected = true,
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
    players: [
      const MatchPlayerInfo(userId: 'user-1', seat: 0, connected: true),
      MatchPlayerInfo(userId: 'user-2', seat: 1, connected: opponentConnected),
    ],
  );
}

Widget _wrap(MatchInfo match, {Future<void> Function(int)? onMove}) {
  return MaterialApp(
    home: TicTacToeScreen(
      match: match,
      currentUserId: 'user-1',
      lastRejection: null,
      onMove: onMove ?? (_) async {},
      onExit: () {},
    ),
  );
}

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

        await tester.tap(find.byType(InkWell).at(0));
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

      await tester.tap(find.byType(InkWell).at(8));
      await tester.pump();

      expect(movedCell, isNull);
    });
  });
}
