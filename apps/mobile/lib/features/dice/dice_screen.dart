import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/match/match_models.dart';
import '../../core/match/widgets/financial_result_banner.dart';
import '../../core/match/widgets/match_action_bar.dart';
import '../../core/match/widgets/match_result_banner.dart';
import '../../core/match/widgets/match_stake_status_bar.dart';
import '../../core/match/widgets/match_status_bar.dart';
import '../../core/match_stakes/match_stake_models.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_motion.dart';
import '../../core/theme/app_radii.dart';
import '../../core/theme/app_spacing.dart';
import 'dice_models.dart';
import 'dice_widgets.dart';

/// The Dice experience: a head-to-head table with both players' round
/// scores, the current attempt's dice, a prominent roll button, and
/// win/loss/draw presentation. Purely a renderer of server-pushed [match]
/// state (see ADR-008 and docs/decisions/ADR-025-dice-game-module.md):
/// tapping "Roll dice" only ever *asks* the server to roll. The dice
/// values, round winners, and match result all come from the server, and
/// the tumble animation is cosmetic. Reuses the same generic chrome
/// (`core/match/widgets/`) as every other game.
class DiceScreen extends StatefulWidget {
  const DiceScreen({
    super.key,
    required this.match,
    required this.currentUserId,
    required this.lastRejection,
    required this.onRoll,
    required this.onExit,
    required this.onResign,
    this.financial = const MatchFinancialInfo.empty(),
    this.onDispute,
  });

  final MatchInfo match;
  final String currentUserId;
  final String? lastRejection;
  final Future<void> Function() onRoll;
  final VoidCallback onExit;
  final Future<void> Function() onResign;
  final MatchFinancialInfo financial;
  final Future<void> Function(String reason)? onDispute;

  @override
  State<DiceScreen> createState() => _DiceScreenState();
}

class _DiceScreenState extends State<DiceScreen> {
  bool _submitting = false;
  bool _hapticFired = false;

  @override
  void didUpdateWidget(DiceScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.match.isFinished && !oldWidget.match.isFinished) {
      _hapticFired = false;
    }
    if (widget.match.isFinished && !_hapticFired) {
      _hapticFired = true;
      HapticFeedback.mediumImpact();
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _submitting = true);
    try {
      await action();
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _handleRoll() {
    HapticFeedback.selectionClick();
    return _run(widget.onRoll);
  }

  Future<void> _handleResign() async {
    final confirmed = await showResignConfirmationDialog(context);
    if (!confirmed || !mounted) return;
    await _run(widget.onResign);
  }

  @override
  Widget build(BuildContext context) {
    final match = widget.match;
    final me = widget.currentUserId;
    final state = DiceBoardState.fromJson(match.state);
    final finished = match.isFinished;
    final isMyTurn = !finished && state.currentTurn == me;
    final animate = !MediaQuery.of(context).disableAnimations;
    final textTheme = Theme.of(context).textTheme;

    final opponent = match.players.firstWhere(
      (p) => p.userId != me,
      orElse: () => match.players.first,
    );
    final stage = _buildStage(
      state: state,
      me: me,
      finished: finished,
      isMyTurn: isMyTurn,
    );
    final note = _outcomeNote(match, me);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Dice'),
        leading: IconButton(
          icon: const Icon(Icons.close),
          tooltip: 'Leave match',
          onPressed: widget.onExit,
        ),
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.xl),
          child: Column(
            children: [
              MatchStatusBar(
                // Icon only: the shared status bar also has to fit the turn
                // text and the countdown, so anything wider overflows on
                // narrow phones. The rule hint lives under the round label.
                leading: const Icon(
                  Icons.casino_outlined,
                  size: 18,
                  semanticLabel: 'Dice',
                ),
                opponentConnected: opponent.connected,
                isMyTurn: isMyTurn,
                finished: finished,
                turnDeadlineAt: match.turnDeadlineAt,
              ),
              if (widget.financial.isFinanciallyBacked) ...[
                const SizedBox(height: AppSpacing.sm),
                MatchStakeStatusBar(stake: widget.financial.stake!),
              ],
              if (!finished)
                MatchActionBar(
                  supportsResignation: match.supportsResignation,
                  supportsDraws: match.supportsDraws,
                  busy: _submitting,
                  onResign: _handleResign,
                  onOfferDraw: () {},
                ),
              const SizedBox(height: AppSpacing.lg),
              Expanded(
                child: SingleChildScrollView(
                  child: Column(
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: _ScoreCard(
                              key: const ValueKey('score-mine'),
                              label: 'You',
                              wins: state.winsFor(me),
                              color: AppColors.pieceP1,
                              active: isMyTurn,
                            ),
                          ),
                          const SizedBox(width: AppSpacing.md),
                          Expanded(
                            child: _ScoreCard(
                              key: const ValueKey('score-theirs'),
                              label: 'Opponent',
                              wins: state.winsFor(opponent.userId),
                              color: AppColors.pieceP2,
                              active: !finished && !isMyTurn,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: AppSpacing.lg),
                      Text(
                        'Round ${state.round}',
                        key: const ValueKey('round-label'),
                        style: textTheme.titleMedium,
                      ),
                      Text(
                        'First to win 2 rounds',
                        key: const ValueKey('rules-hint'),
                        style: textTheme.bodySmall?.copyWith(
                          color: AppColors.onSurfaceMuted,
                        ),
                      ),
                      if (!finished && state.consecutiveTies > 0)
                        Padding(
                          padding: const EdgeInsets.only(top: AppSpacing.xs),
                          child: Text(
                            'Tie ${state.consecutiveTies} of 3. '
                            'Three in a row ends the match in a draw.',
                            key: const ValueKey('tie-note'),
                            textAlign: TextAlign.center,
                            style: textTheme.bodySmall?.copyWith(
                              color: AppColors.kingAccent,
                            ),
                          ),
                        ),
                      const SizedBox(height: AppSpacing.md),
                      DiceRollRow(
                        key: DiceKeys.theirsRow,
                        label: 'Opponent',
                        roll: stage.theirs,
                        keyPrefix: 'theirs',
                        animate: animate,
                        active: !finished && !isMyTurn,
                        emphasis: stage.theirsEmphasis,
                      ),
                      const SizedBox(height: AppSpacing.md),
                      DiceRollRow(
                        key: DiceKeys.mineRow,
                        label: 'You',
                        roll: stage.mine,
                        keyPrefix: 'mine',
                        animate: animate,
                        active: isMyTurn,
                        emphasis: stage.mineEmphasis,
                      ),
                      if (stage.caption != null)
                        Padding(
                          padding: const EdgeInsets.only(top: AppSpacing.lg),
                          child: Text(
                            stage.caption!,
                            key: const ValueKey('stage-caption'),
                            textAlign: TextAlign.center,
                            style: textTheme.bodyMedium,
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              if (widget.lastRejection != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.md),
                  child: Text(
                    widget.lastRejection!,
                    key: const ValueKey('rejection'),
                    style: const TextStyle(color: AppColors.error),
                    textAlign: TextAlign.center,
                  ),
                ),
              if (!finished)
                _RollButton(
                  enabled: isMyTurn && !_submitting,
                  busy: _submitting,
                  isMyTurn: isMyTurn,
                  onPressed: _handleRoll,
                ),
              if (finished) ...[
                if (note != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                    child: Text(
                      note,
                      key: const ValueKey('outcome-note'),
                      textAlign: TextAlign.center,
                      style: textTheme.bodyMedium?.copyWith(
                        color: AppColors.onSurfaceMuted,
                      ),
                    ),
                  ),
                widget.financial.settlement != null
                    ? FinancialResultBanner(
                        currentUserId: me,
                        settlement: widget.financial.settlement!,
                        onExit: widget.onExit,
                        onDispute: widget.onDispute,
                      )
                    : MatchResultBanner(
                        won: match.winnerUserId == me,
                        isDraw: match.resultIsDraw,
                        onExit: widget.onExit,
                      ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Stable keys other code (and tests) can use to find the two roll rows.
abstract final class DiceKeys {
  static const Key mineRow = ValueKey('dice-row-mine');
  static const Key theirsRow = ValueKey('dice-row-theirs');
  static const Key rollButton = ValueKey('dice-roll-button');
}

/// What the table shows for the current moment, derived purely from the
/// server's state: the attempt in progress if the starter has rolled,
/// otherwise the most recently completed attempt.
class _Stage {
  const _Stage({
    required this.mine,
    required this.theirs,
    required this.mineEmphasis,
    required this.theirsEmphasis,
    required this.caption,
  });

  final DiceRollInfo? mine;
  final DiceRollInfo? theirs;
  final DiceFaceEmphasis mineEmphasis;
  final DiceFaceEmphasis theirsEmphasis;
  final String? caption;
}

_Stage _buildStage({
  required DiceBoardState state,
  required String me,
  required bool finished,
  required bool isMyTurn,
}) {
  const neutral = DiceFaceEmphasis.neutral;
  final pending = state.pendingRoll;

  if (pending != null) {
    final rolledByMe = pending.userId == me;
    final String? caption;
    if (finished) {
      caption = null;
    } else if (rolledByMe) {
      caption = 'Your roll is in. Waiting for your opponent.';
    } else {
      caption = 'Your opponent rolled ${pending.total}. Your turn!';
    }
    return _Stage(
      mine: rolledByMe ? pending : null,
      theirs: rolledByMe ? null : pending,
      mineEmphasis: neutral,
      theirsEmphasis: neutral,
      caption: caption,
    );
  }

  final last = state.lastAttempt;
  if (last == null) {
    // Nobody has rolled yet. A match can still be finished here (e.g. an
    // early resignation), in which case there is nothing to caption.
    final String? caption;
    if (finished) {
      caption = null;
    } else if (isMyTurn) {
      caption = 'You roll first. Good luck!';
    } else {
      caption = 'Your opponent rolls first.';
    }
    return _Stage(
      mine: null,
      theirs: null,
      mineEmphasis: neutral,
      theirsEmphasis: neutral,
      caption: caption,
    );
  }

  final mine = last.rolls.firstWhere((r) => r.userId == me);
  final theirs = last.rolls.firstWhere((r) => r.userId != me);
  if (last.isTie) {
    return _Stage(
      mine: mine,
      theirs: theirs,
      mineEmphasis: neutral,
      theirsEmphasis: neutral,
      caption: finished
          ? 'Tied at ${mine.total}.'
          : 'Tied at ${mine.total}. Roll again!',
    );
  }

  const winner = DiceFaceEmphasis.winner;
  const loser = DiceFaceEmphasis.loser;
  final iWonRound = last.winnerUserId == me;
  return _Stage(
    mine: mine,
    theirs: theirs,
    mineEmphasis: iWonRound ? winner : loser,
    theirsEmphasis: iWonRound ? loser : winner,
    caption: iWonRound
        ? 'You won round ${last.round}!'
        : 'Your opponent won round ${last.round}.',
  );
}

/// Explains *how* a finished match ended when it wasn't a plain win by
/// the dice - resignation, a turn timeout, a disconnect, or a draw.
String? _outcomeNote(MatchInfo match, String me) {
  if (!match.isFinished) return null;
  final iWon = match.winnerUserId == me;
  switch (match.terminationReason) {
    case 'RESIGNATION':
      return iWon ? 'Your opponent resigned.' : 'You resigned.';
    case 'TURN_TIMEOUT':
      return iWon
          ? 'Your opponent ran out of time to roll.'
          : 'You ran out of time to roll.';
    case 'ABANDONED_DISCONNECT':
      return iWon ? 'Your opponent disconnected.' : 'You were disconnected.';
  }
  if (match.resultIsDraw) return 'Three ties in a row. The match is a draw.';
  return null;
}

class _ScoreCard extends StatelessWidget {
  const _ScoreCard({
    super.key,
    required this.label,
    required this.wins,
    required this.color,
    required this.active,
  });

  final String label;
  final int wins;
  final Color color;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final labelColor = active
        ? AppColors.onBackground
        : AppColors.onSurfaceMuted;
    return AnimatedContainer(
      duration: AppMotion.normal,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: AppSpacing.md,
      ),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadii.md),
        border: Border.all(
          color: active ? color : Colors.transparent,
          width: 1.5,
        ),
      ),
      child: Column(
        children: [
          Text(
            label,
            style: Theme.of(
              context,
            ).textTheme.labelLarge?.copyWith(color: labelColor),
          ),
          const SizedBox(height: AppSpacing.sm),
          RoundPips(wins: wins, color: color),
        ],
      ),
    );
  }
}

class _RollButton extends StatelessWidget {
  const _RollButton({
    required this.enabled,
    required this.busy,
    required this.isMyTurn,
    required this.onPressed,
  });

  final bool enabled;
  final bool busy;
  final bool isMyTurn;
  final Future<void> Function() onPressed;

  @override
  Widget build(BuildContext context) {
    final String label;
    if (busy) {
      label = 'Rolling...';
    } else if (isMyTurn) {
      label = 'Roll dice';
    } else {
      label = 'Waiting for opponent...';
    }

    return SizedBox(
      width: double.infinity,
      height: 60,
      child: FilledButton.icon(
        key: DiceKeys.rollButton,
        onPressed: enabled ? onPressed : null,
        icon: busy
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2.5,
                  color: AppColors.onPrimary,
                ),
              )
            : const Icon(Icons.casino_outlined),
        label: Text(
          label,
          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
        ),
      ),
    );
  }
}
