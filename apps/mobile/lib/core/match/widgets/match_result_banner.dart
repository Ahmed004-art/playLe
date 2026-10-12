import 'package:flutter/material.dart';

import '../../theme/app_colors.dart';
import '../../theme/app_spacing.dart';

/// The plain (non-financial) win/loss/draw banner shown for a finished
/// free-play match. Extracted from Tic-Tac-Toe's private `_ResultBanner`
/// (Phase 7) so every game shows the same result presentation. See
/// [FinancialResultBanner] for the staked-match counterpart.
class MatchResultBanner extends StatelessWidget {
  const MatchResultBanner({
    super.key,
    required this.won,
    required this.isDraw,
    required this.onExit,
  });

  final bool won;
  final bool isDraw;
  final VoidCallback onExit;

  @override
  Widget build(BuildContext context) {
    final String title;
    final Color color;
    if (isDraw) {
      title = "It's a draw!";
      color = AppColors.onSurfaceMuted;
    } else if (won) {
      title = 'You won! 🎉';
      color = AppColors.secondary;
    } else {
      title = 'You lost';
      color = AppColors.error;
    }

    return Column(
      children: [
        Text(
          title,
          style: Theme.of(
            context,
          ).textTheme.headlineMedium?.copyWith(color: color),
        ),
        const SizedBox(height: AppSpacing.lg),
        FilledButton(onPressed: onExit, child: const Text('Back to account')),
      ],
    );
  }
}
