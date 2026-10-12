import 'package:flutter/material.dart';

import '../../theme/app_colors.dart';
import '../../theme/app_radii.dart';
import '../../theme/app_spacing.dart';

/// The turn/connection status strip shown above every game's board.
/// Extracted from Tic-Tac-Toe's private `_StatusBar` (Phase 7) so
/// Checkers — and any future game — shows the same connection/turn
/// feedback without re-implementing it. [leading] is the one
/// game-specific part (e.g. "You play X" with its mark icon, or "You
/// play Red" with a piece swatch).
class MatchStatusBar extends StatelessWidget {
  const MatchStatusBar({
    super.key,
    required this.leading,
    required this.opponentConnected,
    required this.isMyTurn,
    required this.finished,
  });

  final Widget leading;
  final bool opponentConnected;
  final bool isMyTurn;
  final bool finished;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: AppSpacing.md,
      ),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadii.md),
      ),
      child: Row(
        children: [
          leading,
          const Spacer(),
          if (!opponentConnected && !finished) ...[
            const Icon(Icons.wifi_off, size: 16, color: AppColors.error),
            const SizedBox(width: AppSpacing.sm),
            const Text(
              'Opponent disconnected',
              style: TextStyle(color: AppColors.error),
            ),
          ] else if (!finished)
            Text(
              isMyTurn ? 'Your turn' : "Opponent's turn",
              style: TextStyle(
                color: isMyTurn
                    ? AppColors.secondary
                    : AppColors.onSurfaceMuted,
                fontWeight: isMyTurn ? FontWeight.w600 : FontWeight.normal,
              ),
            ),
        ],
      ),
    );
  }
}
