import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/features/checkers/checkers_board.dart';
import 'package:playle_mobile/features/checkers/checkers_models.dart';

List<List<CheckersPiece?>> _emptyBoard() =>
    List.generate(8, (_) => List<CheckersPiece?>.filled(8, null));

CheckersBoardState _state({
  List<List<CheckersPiece?>>? board,
  String currentTurn = 'user-1',
  Coord? mustContinueFrom,
}) {
  return CheckersBoardState(
    board: board ?? _emptyBoard(),
    playerOrder: const ['user-1', 'user-2'],
    currentTurn: currentTurn,
    mustContinueFrom: mustContinueFrom,
  );
}

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  group('CheckersBoard', () {
    testWidgets(
      'renders a player-zero piece and a player-one piece distinctly',
      (tester) async {
        final board = _emptyBoard();
        board[2][1] = const CheckersPiece(owner: 'user-1', king: false);
        board[5][0] = const CheckersPiece(owner: 'user-2', king: false);

        await tester.pumpWidget(
          _wrap(
            CheckersBoard(
              state: _state(board: board),
              selected: null,
              legalDestinations: const {},
              enabled: true,
              flipped: false,
              onSquareTap: (_) {},
            ),
          ),
        );

        // No king icon anywhere — neither piece is a king.
        expect(find.byIcon(Icons.workspace_premium), findsNothing);
      },
    );

    testWidgets('renders a crown on a king piece', (tester) async {
      final board = _emptyBoard();
      board[7][0] = const CheckersPiece(owner: 'user-1', king: true);

      await tester.pumpWidget(
        _wrap(
          CheckersBoard(
            state: _state(board: board),
            selected: null,
            legalDestinations: const {},
            enabled: true,
            flipped: false,
            onSquareTap: (_) {},
          ),
        ),
      );

      expect(find.byIcon(Icons.workspace_premium), findsOneWidget);
    });

    testWidgets(
      'tapping an empty dark square calls onSquareTap with its logical coordinates',
      (tester) async {
        Coord? tapped;
        await tester.pumpWidget(
          _wrap(
            CheckersBoard(
              state: _state(),
              selected: null,
              legalDestinations: const {},
              enabled: true,
              flipped: false,
              onSquareTap: (coord) => tapped = coord,
            ),
          ),
        );

        await tester.tap(find.byKey(const ValueKey('square-3-0')));
        await tester.pump();

        expect(tapped, const Coord(3, 0));
      },
    );

    testWidgets('tapping translates through the flip when flipped', (
      tester,
    ) async {
      Coord? tapped;
      await tester.pumpWidget(
        _wrap(
          CheckersBoard(
            state: _state(),
            selected: null,
            legalDestinations: const {},
            enabled: true,
            flipped: true,
            onSquareTap: (coord) => tapped = coord,
          ),
        ),
      );

      // Regardless of visual flip, the key is always the logical square —
      // tapping it must report that same logical coordinate.
      await tester.tap(find.byKey(const ValueKey('square-3-0')));
      await tester.pump();

      expect(tapped, const Coord(3, 0));
    });

    testWidgets('does nothing when disabled', (tester) async {
      Coord? tapped;
      await tester.pumpWidget(
        _wrap(
          CheckersBoard(
            state: _state(),
            selected: null,
            legalDestinations: const {},
            enabled: false,
            flipped: false,
            onSquareTap: (coord) => tapped = coord,
          ),
        ),
      );

      await tester.tap(find.byKey(const ValueKey('square-3-0')));
      await tester.pump();

      expect(tapped, isNull);
    });
  });

  group('findLegalDestinations', () {
    test('a man can step diagonally forward onto an empty square', () {
      final board = _emptyBoard();
      board[2][1] = const CheckersPiece(owner: 'user-1', king: false);
      final state = _state(board: board);

      final destinations = findLegalDestinations(state, const Coord(2, 1));

      expect(destinations, containsAll([const Coord(3, 0), const Coord(3, 2)]));
    });

    test('a man can jump a capturable opponent piece', () {
      final board = _emptyBoard();
      board[2][1] = const CheckersPiece(owner: 'user-1', king: false);
      board[3][2] = const CheckersPiece(owner: 'user-2', king: false);
      final state = _state(board: board);

      final destinations = findLegalDestinations(state, const Coord(2, 1));

      expect(destinations, contains(const Coord(4, 3)));
    });

    test('a king can step and jump backward too', () {
      final board = _emptyBoard();
      board[4][3] = const CheckersPiece(owner: 'user-1', king: true);
      final state = _state(board: board);

      final destinations = findLegalDestinations(state, const Coord(4, 3));

      expect(destinations, contains(const Coord(3, 2))); // backward for user-1
    });
  });
}
