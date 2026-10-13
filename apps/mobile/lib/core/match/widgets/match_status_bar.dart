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
          widget.leading,
          const Spacer(),
          if (!widget.opponentConnected && !widget.finished) ...[
            const Icon(Icons.wifi_off, size: 16, color: AppColors.error),
            const SizedBox(width: AppSpacing.sm),
            const Text(
              'Opponent disconnected',
              style: TextStyle(color: AppColors.error),
            ),
          ] else if (!widget.finished) ...[
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
            if (remaining != null) ...[
              const SizedBox(width: AppSpacing.sm),
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
          ],
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
