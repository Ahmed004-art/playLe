import 'package:flutter/material.dart';

import '../../theme/app_colors.dart';
import '../../theme/app_radii.dart';
import '../../theme/app_spacing.dart';
import '../../wallet/money_format.dart';
import '../../match_stakes/match_stake_models.dart';

/// A small, unobtrusive strip showing this match's entry amount and
/// prize pool while it's in progress. Extracted from Tic-Tac-Toe's
/// private `_StakeStatusBar` (Phase 7) so every staked game — not just
/// Tic-Tac-Toe — shows the same stake summary. Never shown for free
/// play; the caller only renders this when `MatchFinancialInfo.stake`
/// is non-null.
class MatchStakeStatusBar extends StatelessWidget {
  const MatchStakeStatusBar({super.key, required this.stake});

  final MatchStakeInfo stake;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: AppSpacing.sm,
      ),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadii.md),
      ),
      child: Row(
        children: [
          const Icon(
            Icons.payments_outlined,
            size: 14,
            color: AppColors.secondary,
          ),
          const SizedBox(width: AppSpacing.sm),
          // `Expanded` so a large amount or a big text scale wraps onto a
          // second line instead of overflowing the strip.
          Expanded(
            child: Text(
              'Entry ${formatMinorAmount(stake.stakeAmountMinor, currency: stake.currency)} · '
              'Pool ${formatMinorAmount(stake.poolAmountMinor, currency: stake.currency)}',
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceMuted),
            ),
          ),
        ],
      ),
    );
  }
}
