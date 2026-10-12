/// Mirrors the API's `CheckersState`/`CheckersPiece`/`Coord` (see
/// `apps/api/src/games/checkers/checkers.types.ts`). `Match.state` is
/// opaque JSON on the wire — this is the one place that parses it into a
/// typed shape for the Checkers screen/board to render. Purely a
/// client-side view: every field here mirrors what the server already
/// decided (see ADR-008) — nothing here computes a result.
class Coord {
  const Coord(this.row, this.col);

  factory Coord.fromJson(Map<String, dynamic> json) =>
      Coord(json['row'] as int, json['col'] as int);

  final int row;
  final int col;

  Map<String, dynamic> toJson() => {'row': row, 'col': col};

  @override
  bool operator ==(Object other) =>
      other is Coord && other.row == row && other.col == col;

  @override
  int get hashCode => Object.hash(row, col);

  @override
  String toString() => 'Coord($row, $col)';
}

class CheckersPiece {
  const CheckersPiece({required this.owner, required this.king});

  factory CheckersPiece.fromJson(Map<String, dynamic> json) =>
      CheckersPiece(owner: json['owner'] as String, king: json['king'] as bool);

  final String owner;
  final bool king;
}

class CheckersBoardState {
  const CheckersBoardState({
    required this.board,
    required this.playerOrder,
    required this.currentTurn,
    required this.mustContinueFrom,
  });

  factory CheckersBoardState.fromJson(Map<String, dynamic> json) {
    final rawBoard = (json['board'] as List).cast<List<dynamic>>();
    final board = rawBoard
        .map(
          (row) => row
              .cast<Map<String, dynamic>?>()
              .map((cell) => cell == null ? null : CheckersPiece.fromJson(cell))
              .toList(),
        )
        .toList();
    final playerOrder = (json['playerOrder'] as List).cast<String>();
    final mustContinueRaw = json['mustContinueFrom'] as Map<String, dynamic>?;
    return CheckersBoardState(
      board: board,
      playerOrder: [playerOrder[0], playerOrder[1]],
      currentTurn: json['currentTurn'] as String,
      mustContinueFrom: mustContinueRaw == null
          ? null
          : Coord.fromJson(mustContinueRaw),
    );
  }

  final List<List<CheckersPiece?>> board;
  final List<String> playerOrder;
  final String currentTurn;
  final Coord? mustContinueFrom;

  CheckersPiece? at(Coord coord) => board[coord.row][coord.col];

  static const boardSize = 8;

  static bool isDarkSquare(int row, int col) => (row + col) % 2 == 1;
  static bool inBounds(int row, int col) =>
      row >= 0 && row < boardSize && col >= 0 && col < boardSize;
}
