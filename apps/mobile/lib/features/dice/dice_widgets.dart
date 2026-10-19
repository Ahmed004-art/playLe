import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_motion.dart';
import '../../core/theme/app_radii.dart';
import '../../core/theme/app_spacing.dart';
import 'dice_models.dart';

/// How a die is emphasized once a round is decided.
enum DiceFaceEmphasis { neutral, winner, loser }

/// Pip positions for each face value, as alignments inside the die.
const List<List<Alignment>> _pipLayouts = [
  [],
  [Alignment.center],
  [Alignment.topLeft, Alignment.bottomRight],
  [Alignment.topLeft, Alignment.center, Alignment.bottomRight],
  [
    Alignment.topLeft,
    Alignment.topRight,
    Alignment.bottomLeft,
    Alignment.bottomRight,
  ],
  [
    Alignment.topLeft,
    Alignment.topRight,
    Alignment.center,
    Alignment.bottomLeft,
    Alignment.bottomRight,
  ],
  [
    Alignment.topLeft,
    Alignment.centerLeft,
    Alignment.bottomLeft,
    Alignment.topRight,
    Alignment.centerRight,
    Alignment.bottomRight,
  ],
];

/// A single die face showing [value] (1-6) with clear pips, or an
/// unrolled placeholder when [value] is null. A pure renderer: the value
/// is always whatever the server already rolled (ADR-025).
class DiceFace extends StatelessWidget {
  const DiceFace({
    super.key,
    required this.value,
    this.size = 64,
    this.emphasis = DiceFaceEmphasis.neutral,
  });

  final int? value;
  final double size;
  final DiceFaceEmphasis emphasis;

  @override
  Widget build(BuildContext context) {
    final face = value;
    final isWinner = emphasis == DiceFaceEmphasis.winner;
    final borderColor = isWinner
        ? AppColors.secondary
        : AppColors.onSurfaceMuted.withValues(alpha: 0.35);
    final shadowColor = isWinner
        ? AppColors.secondary.withValues(alpha: 0.45)
        : Colors.black.withValues(alpha: 0.35);

    return Semantics(
      label: face == null ? 'Die not rolled yet' : 'Die showing $face',
      excludeSemantics: true,
      child: Opacity(
        opacity: emphasis == DiceFaceEmphasis.loser ? 0.5 : 1,
        child: Container(
          width: size,
          height: size,
          padding: EdgeInsets.all(size * 0.16),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(size * 0.24),
            color: face == null ? AppColors.surface : null,
            gradient: face == null
                ? null
                : const LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [AppColors.diceFaceLight, AppColors.diceFaceShade],
                  ),
            border: Border.all(color: borderColor, width: isWinner ? 2.5 : 1),
            boxShadow: [
              BoxShadow(
                color: shadowColor,
                blurRadius: isWinner ? 18 : 10,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: face == null
              ? Center(
                  child: Text(
                    '?',
                    style: TextStyle(
                      color: AppColors.onSurfaceMuted,
                      fontSize: size * 0.4,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                )
              : Stack(
                  children: [
                    for (final alignment in _pipLayouts[face])
                      Align(
                        alignment: alignment,
                        child: Container(
                          key: const ValueKey('dice-pip'),
                          width: size * 0.17,
                          height: size * 0.17,
                          decoration: const BoxDecoration(
                            color: AppColors.dicePip,
                            shape: BoxShape.circle,
                          ),
                        ),
                      ),
                  ],
                ),
        ),
      ),
    );
  }
}

/// A [DiceFace] that tumbles for a moment whenever [value] changes to a
/// new server-rolled number, then settles on exactly that number.
///
/// The animation is **purely cosmetic**: while it runs it cycles through
/// faces in a fixed order (never a local random draw), and the instant it
/// ends - or immediately when [animate] is false, i.e. reduced motion is
/// on - the widget shows [value], which only ever comes from the server.
/// Nothing here can influence, predict, or replace a roll's outcome.
class TumblingDie extends StatefulWidget {
  const TumblingDie({
    super.key,
    required this.value,
    required this.size,
    this.emphasis = DiceFaceEmphasis.neutral,
    this.animate = true,
  });

  final int? value;
  final double size;
  final DiceFaceEmphasis emphasis;
  final bool animate;

  @override
  State<TumblingDie> createState() => _TumblingDieState();
}

class _TumblingDieState extends State<TumblingDie>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppMotion.tumble,
  );

  @override
  void didUpdateWidget(TumblingDie oldWidget) {
    super.didUpdateWidget(oldWidget);
    final changed = widget.value != null && widget.value != oldWidget.value;
    if (changed && widget.animate) {
      _controller.forward(from: 0);
    } else if (!widget.animate && _controller.isAnimating) {
      _controller.stop();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final running = widget.animate && _controller.isAnimating;
        final t = _controller.value;
        final shown = running ? (t * 14).floor() % 6 + 1 : widget.value;
        final wobble = math.sin(t * math.pi * 3);
        final angle = running ? wobble * 0.4 * (1 - t) : 0.0;
        final scale = running ? 1 + 0.14 * math.sin(t * math.pi) : 1.0;
        return Transform.rotate(
          angle: angle,
          child: Transform.scale(
            scale: scale,
            child: DiceFace(
              value: shown,
              size: widget.size,
              emphasis: running ? DiceFaceEmphasis.neutral : widget.emphasis,
            ),
          ),
        );
      },
    );
  }
}

/// One player's row on the dice table: a label, their two dice, and the
/// total, or empty placeholders until they have rolled. [keyPrefix] gives
/// the dice and total stable keys, so the same on-screen die keeps its
/// animation state as new server state arrives.
class DiceRollRow extends StatelessWidget {
  const DiceRollRow({
    super.key,
    required this.label,
    required this.roll,
    required this.keyPrefix,
    required this.animate,
    this.active = false,
    this.emphasis = DiceFaceEmphasis.neutral,
    this.dieSize = 60,
  });

  final String label;
  final DiceRollInfo? roll;
  final String keyPrefix;
  final bool animate;
  final bool active;
  final DiceFaceEmphasis emphasis;
  final double dieSize;

  @override
  Widget build(BuildContext context) {
    final current = roll;
    final textTheme = Theme.of(context).textTheme;
    final totalColor = switch (emphasis) {
      DiceFaceEmphasis.winner => AppColors.secondary,
      DiceFaceEmphasis.loser => AppColors.onSurfaceMuted,
      DiceFaceEmphasis.neutral => AppColors.onBackground,
    };

    return AnimatedContainer(
      duration: AppMotion.normal,
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(
          color: active
              ? AppColors.secondary.withValues(alpha: 0.7)
              : Colors.transparent,
          width: 1.5,
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: textTheme.labelLarge?.copyWith(
                    color: AppColors.onSurfaceMuted,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
                Row(
                  children: [
                    TumblingDie(
                      key: ValueKey('$keyPrefix-die-0'),
                      value: current?.dice[0],
                      size: dieSize,
                      emphasis: emphasis,
                      animate: animate,
                    ),
                    const SizedBox(width: AppSpacing.md),
                    TumblingDie(
                      key: ValueKey('$keyPrefix-die-1'),
                      value: current?.dice[1],
                      size: dieSize,
                      emphasis: emphasis,
                      animate: animate,
                    ),
                  ],
                ),
              ],
            ),
          ),
          Column(
            children: [
              Text(
                'TOTAL',
                style: textTheme.labelSmall?.copyWith(
                  color: AppColors.onSurfaceMuted,
                  letterSpacing: 1.2,
                ),
              ),
              Text(
                current == null ? '-' : '${current.total}',
                key: ValueKey('$keyPrefix-total'),
                style: textTheme.displaySmall?.copyWith(
                  color: totalColor,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// A player's round-win tally as filled/empty pips toward
/// [DiceBoardState.roundsToWin].
class RoundPips extends StatelessWidget {
  const RoundPips({super.key, required this.wins, required this.color});

  final int wins;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: '$wins of ${DiceBoardState.roundsToWin} rounds won',
      excludeSemantics: true,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < DiceBoardState.roundsToWin; i++)
            Padding(
              padding: const EdgeInsets.only(right: AppSpacing.xs),
              child: Container(
                width: 14,
                height: 14,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: i < wins ? color : Colors.transparent,
                  border: Border.all(color: color, width: 1.5),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
