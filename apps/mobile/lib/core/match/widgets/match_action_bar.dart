import 'package:flutter/material.dart';

import '../../theme/app_colors.dart';
import '../../theme/app_spacing.dart';

/// Shows a confirmation dialog before resigning — an irreversible
/// forfeit (Phase 9 — ADR-024) — and returns `true` only if the user
/// confirmed. Extracted as a top-level function so it's testable without
/// the rest of the action bar.
Future<bool> showResignConfirmationDialog(BuildContext context) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Resign this match?'),
      content: const Text(
        'You will immediately lose this match. This cannot be undone.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: AppColors.error),
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text('Resign'),
        ),
      ],
    ),
  );
  return result ?? false;
}

/// "Resign" / "Offer draw" actions, shown above a game's board while a
/// match is still in progress. Reused identically by every game through
/// the shared match chrome (Phase 9 — ADR-024), mirroring how
/// `MatchStatusBar`/`MatchStakeStatusBar` are already shared. Each
/// action is hidden outright (not merely disabled) when the game's
/// capabilities say it isn't supported, per ADR-024's "represent
/// capabilities explicitly, never assume universal support."
class MatchActionBar extends StatelessWidget {
  const MatchActionBar({
    super.key,
    required this.supportsResignation,
    required this.supportsDraws,
    required this.busy,
    required this.onResign,
    required this.onOfferDraw,
  });

  final bool supportsResignation;
  final bool supportsDraws;
  final bool busy;
  final VoidCallback onResign;
  final VoidCallback onOfferDraw;

  @override
  Widget build(BuildContext context) {
    if (!supportsResignation && !supportsDraws) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.sm),
      child: Wrap(
        spacing: AppSpacing.sm,
        children: [
          if (supportsDraws)
            OutlinedButton(
              onPressed: busy ? null : onOfferDraw,
              child: const Text('Offer draw'),
            ),
          if (supportsResignation)
            OutlinedButton(
              style: OutlinedButton.styleFrom(foregroundColor: AppColors.error),
              onPressed: busy ? null : onResign,
              child: const Text('Resign'),
            ),
        ],
      ),
    );
  }
}

/// Shown whenever a draw offer is pending — one of two shapes depending
/// on whether the viewer is the one who sent it. A draw offer is not
/// itself a completed draw (ADR-024); this banner just surfaces its
/// status and the one action available to each side.
class DrawOfferBanner extends StatelessWidget {
  const DrawOfferBanner({
    super.key,
    required this.isMine,
    required this.busy,
    required this.onAccept,
    required this.onReject,
  });

  final bool isMine;
  final bool busy;
  final VoidCallback onAccept;
  final VoidCallback onReject;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: AppSpacing.sm),
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.secondary.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              isMine
                  ? 'Draw offer sent — waiting for your opponent'
                  : 'Your opponent offered a draw',
            ),
          ),
          if (!isMine) ...[
            TextButton(
              onPressed: busy ? null : onReject,
              child: const Text('Decline'),
            ),
            FilledButton(
              onPressed: busy ? null : onAccept,
              child: const Text('Accept'),
            ),
          ] else
            TextButton(
              onPressed: busy ? null : onReject,
              child: const Text('Cancel'),
            ),
        ],
      ),
    );
  }
}
