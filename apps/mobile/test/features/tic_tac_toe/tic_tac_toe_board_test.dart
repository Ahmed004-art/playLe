import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/features/tic_tac_toe/tic_tac_toe_board.dart';

String? _markFor(String userId) => userId == 'user-1' ? 'X' : 'O';

Widget _wrap(Widget child) => MaterialApp(
  home: Scaffold(
    body: Padding(padding: const EdgeInsets.all(8), child: child),
  ),
);

void main() {
  group('TicTacToeBoard', () {
    testWidgets('renders marks for occupied cells and nothing for empty ones', (
      tester,
    ) async {
      final board = List<String?>.filled(9, null);
      board[0] = 'user-1';
      board[4] = 'user-2';

      await tester.pumpWidget(
        _wrap(
          TicTacToeBoard(
            board: board,
            markFor: _markFor,
            winningLine: null,
            enabled: true,
            onCellTap: (_) {},
          ),
        ),
      );

      expect(find.byIcon(Icons.close_rounded), findsOneWidget);
      expect(find.byIcon(Icons.circle_outlined), findsOneWidget);
    });

    testWidgets(
      'tapping an empty cell when enabled calls onCellTap with its index',
      (tester) async {
        int? tappedCell;
        await tester.pumpWidget(
          _wrap(
            TicTacToeBoard(
              board: List<String?>.filled(9, null),
              markFor: _markFor,
              winningLine: null,
              enabled: true,
              onCellTap: (cell) => tappedCell = cell,
            ),
          ),
        );

        await tester.tap(find.byType(InkWell).at(4));
        await tester.pump();

        expect(tappedCell, 4);
      },
    );

    testWidgets('tapping a cell is a no-op when the board is disabled', (
      tester,
    ) async {
      int? tappedCell;
      await tester.pumpWidget(
        _wrap(
          TicTacToeBoard(
            board: List<String?>.filled(9, null),
            markFor: _markFor,
            winningLine: null,
            enabled: false,
            onCellTap: (cell) => tappedCell = cell,
          ),
        ),
      );

      await tester.tap(find.byType(InkWell).at(4));
      await tester.pump();

      expect(tappedCell, isNull);
    });

    testWidgets(
      'tapping an already-occupied cell is a no-op even when enabled',
      (tester) async {
        int? tappedCell;
        final board = List<String?>.filled(9, null);
        board[4] = 'user-1';

        await tester.pumpWidget(
          _wrap(
            TicTacToeBoard(
              board: board,
              markFor: _markFor,
              winningLine: null,
              enabled: true,
              onCellTap: (cell) => tappedCell = cell,
            ),
          ),
        );

        await tester.tap(find.byType(InkWell).at(4));
        await tester.pump();

        expect(tappedCell, isNull);
      },
    );
  });

  group('findWinningLine', () {
    test('finds a completed top row', () {
      final board = List<String?>.filled(9, null);
      board[0] = board[1] = board[2] = 'user-1';
      expect(findWinningLine(board), [0, 1, 2]);
    });

    test('finds a completed diagonal', () {
      final board = List<String?>.filled(9, null);
      board[0] = board[4] = board[8] = 'user-1';
      expect(findWinningLine(board), [0, 4, 8]);
    });

    test('returns null when there is no winning line', () {
      final board = List<String?>.filled(9, null);
      board[0] = 'user-1';
      board[1] = 'user-2';
      expect(findWinningLine(board), isNull);
    });
  });
}
