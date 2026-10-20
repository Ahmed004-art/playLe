import 'dart:async';

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
///
/// [turnDeadlineAt] (Phase 9 — ADR-024), when present and the match
/// isn't finished, drives a live "Xs left" countdown next to the turn
/// text — purely a display convenience ticking down a value the server
/// already computed; the server, not this widget, is the sole arbiter
/// of an actual expiry (via `MatchTimeoutService`'s sweep).
class MatchStatusBar extends StatefulWidget {
  const MatchStatusBar({
    super.key,
    required this.leading,
    required this.opponentConnected,
    required this.isMyTurn,
    required this.finished,
    this.turnDeadlineAt,
  });

  final Widget leading;
  final bool opponentConnected;
  final bool isMyTurn;
  final bool finished;
  final DateTime? turnDeadlineAt;

  @override
  State<MatchStatusBar> createState() => _MatchStatusBarState();
}

class _MatchStatusBarState extends State<MatchStatusBar> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _ensureTicking();
  }

  @override
  void didUpdateWidget(MatchStatusBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    _ensureTicking();
  }

  void _ensureTicking() {
    final shouldTick = widget.turnDeadlineAt != null && !widget.finished;
    if (shouldTick && _ticker == null) {
      _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } else if (!shouldTick && _ticker != null) {
      _ticker!.cancel();
      _ticker = null;
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final remaining = _remainingSeconds();
    return Container(
      // Full width, as the old `Row` was: a bare `Wrap` shrink-wraps to its
      // content, which would leave a narrow centered pill.
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: AppSpacing.md,
      ),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadii.md),
      ),
      // A `Wrap`, not a `Row`: leading and status share one line while they
      // fit, and the status drops to a second line instead of overflowing
      // on a narrow screen, a long countdown, or a large text scale
      // (OUTSTANDING_WORK item 25). Same look as before whenever it fits.
      child: Wrap(
        alignment: WrapAlignment.spaceBetween,
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: AppSpacing.sm,
        runSpacing: AppSpacing.xs,
        children: [
          // Scales the game-specific `leading` down only if it alone is
          // wider than the whole bar (a huge text scale); otherwise it keeps
          // its natural size. Callers' leading rows can't wrap themselves.
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: widget.leading,
          ),
          if (!widget.opponentConnected && !widget.finished)
            Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: AppSpacing.sm,
              children: const [
                Icon(Icons.wifi_off, size: 16, color: AppColors.error),
                Text(
                  'Opponent disconnected',
                  style: TextStyle(color: AppColors.error),
                ),
              ],
            )
          else if (!widget.finished)
            Wrap(
              alignment: WrapAlignment.end,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: AppSpacing.sm,
              children: [
                Text(
                  widget.isMyTurn ? 'Your turn' : "Opponent's turn",
                  style: TextStyle(
                    color: widget.isMyTurn
                        ? AppColors.secondary
                        : AppColors.onSurfaceMuted,
                    fontWeight: widget.isMyTurn
                        ? FontWeight.w600
                        : FontWeight.normal,
                  ),
                ),
                if (remaining != null)
                  Text(
                    '(${_format(remaining)})',
                    style: TextStyle(
                      color: remaining <= 10
                          ? AppColors.error
                          : AppColors.onSurfaceMuted,
                      fontWeight: remaining <= 10
                          ? FontWeight.w600
                          : FontWeight.normal,
                    ),
                  ),
              ],
            ),
        ],
      ),
    );
  }

  int? _remainingSeconds() {
    final deadline = widget.turnDeadlineAt;
    if (deadline == null || widget.finished) return null;
    final diff = deadline.difference(DateTime.now()).inSeconds;
    return diff < 0 ? 0 : diff;
  }

  String _format(int seconds) {
    final minutes = seconds ~/ 60;
    final secs = seconds % 60;
    return minutes > 0 ? '${minutes}m ${secs}s left' : '${secs}s left';
  }
}
