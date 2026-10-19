import 'package:flutter/material.dart';

import '../../errors/app_exception.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_spacing.dart';
import '../../wallet/money_format.dart';
import '../../match_stakes/match_stake_models.dart';
import 'dispute_reason_dialog.dart';

/// The financial-aware counterpart of [MatchResultBanner], shown instead
/// of it once a match has a [SettlementInfo] (i.e. it was staked).
/// Extracted from Tic-Tac-Toe's private `_FinancialResultBanner`
/// (Phase 7) so every staked game shows the same win/loss/draw/cancelled
/// presentation and the same dispute flow.
class FinancialResultBanner extends StatelessWidget {
  const FinancialResultBanner({
    super.key,
    required this.currentUserId,
    required this.settlement,
    required this.onExit,
    required this.onDispute,
  });

  final String currentUserId;
  final SettlementInfo settlement;
  final VoidCallback onExit;
  final Future<void> Function(String reason)? onDispute;

  @override
  Widget build(BuildContext context) {
    final entry = settlement.entryFor(currentUserId);
    final currency = settlement.currency;
    final String title;
    final Color color;
    final String subtitle;

    switch (settlement.outcome) {
      case 'WIN':
        if (entry?.role == 'WINNER') {
          title = 'You won! 🎉';
          color = AppColors.secondary;
          subtitle =
              'Prize pool ${formatMinorAmount(settlement.poolAmountMinor, currency: currency)} · '
              'Platform fee ${formatMinorAmount(settlement.platformFeeAmountMinor, currency: currency)}\n'
              'You received ${formatMinorAmount(entry?.availableDeltaMinor ?? '0', currency: currency)}';
        } else {
          title = 'You lost';
          color = AppColors.error;
          subtitle = 'Your entry was used — it went into the prize pool.';
        }
        break;
      case 'DRAW':
        title = "It's a draw!";
        color = AppColors.onSurfaceMuted;
        subtitle =
            'Your stake of ${formatMinorAmount(entry?.availableDeltaMinor ?? '0', currency: currency)} '
            'was refunded in full.';
        break;
      default:
        // REFUND / CANCELLED
        title = 'Match cancelled';
        color = AppColors.onSurfaceMuted;
        subtitle =
            'Your stake of ${formatMinorAmount(entry?.availableDeltaMinor ?? '0', currency: currency)} '
            'was refunded.';
    }

    return Column(
      children: [
        Text(
          title,
          style: Theme.of(
            context,
          ).textTheme.headlineMedium?.copyWith(color: color),
        ),
        const SizedBox(height: AppSpacing.sm),
        Text(
          subtitle,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: AppSpacing.lg),
        // Wraps instead of overflowing when both buttons don't fit.
        Wrap(
          alignment: WrapAlignment.center,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: AppSpacing.md,
          runSpacing: AppSpacing.sm,
          children: [
            if (onDispute != null)
              OutlinedButton(
                onPressed: () => _fileDispute(context),
                child: const Text('Dispute'),
              ),
            FilledButton(
              onPressed: onExit,
              child: const Text('Back to account'),
            ),
          ],
        ),
      ],
    );
  }

  Future<void> _fileDispute(BuildContext context) async {
    final reason = await showDialog<String>(
      context: context,
      builder: (context) => const DisputeReasonDialog(),
    );
    if (reason == null || !context.mounted) return;

    final messenger = ScaffoldMessenger.of(context);
    try {
      await onDispute?.call(reason);
      messenger.showSnackBar(const SnackBar(content: Text('Dispute filed.')));
    } on AppException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }
}
