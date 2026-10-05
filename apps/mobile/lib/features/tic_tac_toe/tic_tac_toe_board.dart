import 'package:flutter/material.dart';

import '../../core/theme/app_colors.dart';

const List<List<int>> kWinLines = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

/// Finds which line of 3 matching, non-null cells won — purely cosmetic
/// (the server already decided the actual outcome in `winnerUserId`; this
/// only figures out *which* line to draw through). Returns `null` if
/// none (e.g. a draw).
List<int>? findWinningLine(List<String?> board) {
  for (final line in kWinLines) {
    final a = board[line[0]];
    if (a != null && a == board[line[1]] && a == board[line[2]]) {
      return line;
    }
  }
  return null;
}

/// The 3x3 board. Purely presentational: [board] is `userId` per cell
/// (or null), [markFor] maps a userId to the X/O glyph it should render.
/// Never decides anything about the game itself.
class TicTacToeBoard extends StatelessWidget {
  const TicTacToeBoard({
    super.key,
    required this.board,
    required this.markFor,
    required this.winningLine,
    required this.enabled,
    required this.onCellTap,
  });

  final List<String?> board;
  final String? Function(String userId) markFor;
  final List<int>? winningLine;
  final bool enabled;
  final void Function(int cell) onCellTap;

  @override
  Widget build(BuildContext context) {
    return AspectRatio(
      aspectRatio: 1,
      child: Stack(
        children: [
          GridView.builder(
            physics: const NeverScrollableScrollPhysics(),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 3,
              mainAxisSpacing: 10,
              crossAxisSpacing: 10,
            ),
            itemCount: 9,
            itemBuilder: (context, index) {
              final occupant = board[index];
              final mark = occupant != null ? markFor(occupant) : null;
              final isWinningCell = winningLine?.contains(index) ?? false;

              return _BoardCell(
                mark: mark,
                highlighted: isWinningCell,
                onTap: enabled && occupant == null
                    ? () => onCellTap(index)
                    : null,
              );
            },
          ),
        ],
      ),
    );
  }
}

class _BoardCell extends StatelessWidget {
  const _BoardCell({
    required this.mark,
    required this.highlighted,
    required this.onTap,
  });

  final String? mark;
  final bool highlighted;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: highlighted
          ? AppColors.secondary.withValues(alpha: 0.18)
          : AppColors.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Center(
          child: TweenAnimationBuilder<double>(
            tween: Tween(begin: 0, end: mark != null ? 1 : 0),
            duration: const Duration(milliseconds: 220),
            curve: Curves.easeOutBack,
            builder: (context, scale, child) {
              return Transform.scale(scale: scale, child: child);
            },
            child: mark == null
                ? const SizedBox.shrink()
                : Icon(
                    mark == 'X' ? Icons.close_rounded : Icons.circle_outlined,
                    size: 48,
                    color: mark == 'X'
                        ? AppColors.primary
                        : AppColors.secondary,
                  ),
          ),
        ),
      ),
    );
  }
}
