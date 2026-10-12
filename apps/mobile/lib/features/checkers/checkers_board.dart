import 'package:flutter/material.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_motion.dart';
import 'checkers_models.dart';

/// Cosmetic-only legal-destination hint for the currently selected piece
/// — purely a UX aid, exactly like Tic-Tac-Toe's `findWinningLine`. The
/// server independently re-validates every move regardless of what this
/// highlights; a move this misses as "legal" (e.g. because a *different*
/// piece elsewhere has a mandatory capture) is still correctly rejected
/// server-side and surfaced via the normal rejection-message path.
List<Coord> findLegalDestinations(CheckersBoardState state, Coord from) {
  final piece = state.at(from);
  if (piece == null) return const [];
  final forwardDir = piece.owner == state.playerOrder[0] ? 1 : -1;
  final dirs = piece.king
      ? const [(-1, -1), (-1, 1), (1, -1), (1, 1)]
      : [(forwardDir, -1), (forwardDir, 1)];

  final destinations = <Coord>[];
  for (final (dr, dc) in dirs) {
    final simpleRow = from.row + dr;
    final simpleCol = from.col + dc;
    if (CheckersBoardState.inBounds(simpleRow, simpleCol) &&
        state.board[simpleRow][simpleCol] == null) {
      destinations.add(Coord(simpleRow, simpleCol));
    }

    final jumpRow = from.row + dr * 2;
    final jumpCol = from.col + dc * 2;
    if (CheckersBoardState.inBounds(jumpRow, jumpCol) &&
        state.board[jumpRow][jumpCol] == null) {
      final midPiece = state.board[from.row + dr][from.col + dc];
      if (midPiece != null && midPiece.owner != piece.owner) {
        destinations.add(Coord(jumpRow, jumpCol));
      }
    }
  }
  return destinations;
}

/// The 8x8 board. Purely presentational — [state] is the authoritative,
/// already-parsed server state; [selected]/[legalDestinations] are the
/// caller's cosmetic UI state. Never decides anything about the game
/// itself (see ADR-008). [flipped] renders the board from
/// `playerOrder[1]`'s perspective (their own pieces at the bottom,
/// moving "up" the screen) — the standard board-game convention, rather
/// than always showing `playerOrder[0]`'s fixed orientation.
class CheckersBoard extends StatelessWidget {
  const CheckersBoard({
    super.key,
    required this.state,
    required this.selected,
    required this.legalDestinations,
    required this.enabled,
    required this.flipped,
    required this.onSquareTap,
  });

  final CheckersBoardState state;
  final Coord? selected;
  final Set<Coord> legalDestinations;
  final bool enabled;
  final bool flipped;
  final void Function(Coord coord) onSquareTap;

  @override
  Widget build(BuildContext context) {
    const size = CheckersBoardState.boardSize;
    return AspectRatio(
      aspectRatio: 1,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: GridView.builder(
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: size,
          ),
          itemCount: size * size,
          itemBuilder: (context, index) {
            final displayRow = index ~/ size;
            final displayCol = index % size;
            final row = flipped ? size - 1 - displayRow : displayRow;
            final col = flipped ? size - 1 - displayCol : displayCol;
            final coord = Coord(row, col);
            final dark = CheckersBoardState.isDarkSquare(row, col);
            final piece = dark ? state.board[row][col] : null;
            final isSelected = selected == coord;
            final isMustContinue = state.mustContinueFrom == coord;
            final isLegalHint = legalDestinations.contains(coord);

            return _Square(
              key: ValueKey('square-$row-$col'),
              dark: dark,
              piece: piece,
              // Absolute by seat (playerOrder[0] is always `pieceP1`,
              // playerOrder[1] is always `pieceP2`) — the same convention
              // Tic-Tac-Toe's X/O already uses, so both players see the
              // same colors on their screens; only the status bar's "You
              // play ..." label differs per viewer.
              isPlayerZero:
                  piece != null && piece.owner == state.playerOrder[0],
              selected: isSelected || isMustContinue,
              legalHint: isLegalHint,
              onTap: dark && enabled ? () => onSquareTap(coord) : null,
            );
          },
        ),
      ),
    );
  }
}

class _Square extends StatelessWidget {
  const _Square({
    super.key,
    required this.dark,
    required this.piece,
    required this.isPlayerZero,
    required this.selected,
    required this.legalHint,
    required this.onTap,
  });

  final bool dark;
  final CheckersPiece? piece;
  final bool isPlayerZero;
  final bool selected;
  final bool legalHint;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        color: dark ? AppColors.boardDark : AppColors.boardLight,
        child: Center(
          child: Stack(
            alignment: Alignment.center,
            children: [
              if (selected)
                Container(
                  margin: const EdgeInsets.all(2),
                  decoration: BoxDecoration(
                    border: Border.all(color: AppColors.kingAccent, width: 2),
                    borderRadius: BorderRadius.circular(4),
                  ),
                ),
              if (legalHint && piece == null)
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                    color: AppColors.secondary.withValues(alpha: 0.6),
                    shape: BoxShape.circle,
                  ),
                ),
              if (piece != null)
                _Piece(piece: piece!, isPlayerZero: isPlayerZero),
            ],
          ),
        ),
      ),
    );
  }
}

class _Piece extends StatelessWidget {
  const _Piece({required this.piece, required this.isPlayerZero});

  final CheckersPiece piece;
  final bool isPlayerZero;

  @override
  Widget build(BuildContext context) {
    final color = isPlayerZero ? AppColors.pieceP1 : AppColors.pieceP2;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: AppMotion.normal,
      curve: AppMotion.entrance,
      builder: (context, scale, child) {
        return Transform.scale(scale: scale, child: child);
      },
      child: FractionallySizedBox(
        widthFactor: 0.72,
        heightFactor: 0.72,
        child: Container(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: RadialGradient(
              colors: [color.withValues(alpha: 0.95), color],
              center: const Alignment(-0.3, -0.3),
            ),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.35),
                blurRadius: 3,
                offset: const Offset(0, 2),
              ),
            ],
            border: Border.all(
              color: Colors.black.withValues(alpha: 0.2),
              width: 1,
            ),
          ),
          child: piece.king
              ? Center(
                  child: TweenAnimationBuilder<double>(
                    tween: Tween(begin: 0, end: 1),
                    duration: AppMotion.slow,
                    curve: AppMotion.entrance,
                    builder: (context, scale, child) {
                      return Transform.scale(scale: scale, child: child);
                    },
                    child: const Icon(
                      Icons.workspace_premium,
                      color: AppColors.kingAccent,
                      size: 18,
                    ),
                  ),
                )
              : null,
        ),
      ),
    );
  }
}
