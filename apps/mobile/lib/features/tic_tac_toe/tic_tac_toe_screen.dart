import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/errors/app_exception.dart';
import '../../core/match/match_models.dart';
import '../../core/match_stakes/match_stake_models.dart';
import '../../core/theme/app_colors.dart';
import '../../core/wallet/money_format.dart';
import 'tic_tac_toe_board.dart';

/// The polished Tic-Tac-Toe experience: board, turn/connection
/// indicators, and victory/draw/defeat presentation. Purely a renderer
/// of server-pushed [match] state (see ADR-008) — it never decides whose
/// turn it is or who won; it only *displays* what the board already
/// shows and what `match.winnerUserId`/`resultIsDraw` already say.
class TicTacToeScreen extends StatefulWidget {
  const TicTacToeScreen({
    super.key,
    required this.match,
    required this.currentUserId,
    required this.lastRejection,
    required this.onMove,
    required this.onExit,
    this.financial = const MatchFinancialInfo.empty(),
    this.onDispute,
  });

  final MatchInfo match;
  final String currentUserId;
  final String? lastRejection;
  final Future<void> Function(int cell) onMove;
  final VoidCallback onExit;

  /// This match's stake/settlement, if any. Defaults to the "nothing
  /// financial here" shape, so every pre-Phase-5 call site (and every
  /// free-play match) renders exactly as before — no stake status bar,
  /// no financial result banner.
  final MatchFinancialInfo financial;

  /// Files a dispute against this (now-finished) match. `null` when the
  /// caller has no dispute flow wired up — the result banner simply
  /// omits the "Dispute" action in that case.
  final Future<void> Function(String reason)? onDispute;

  @override
  State<TicTacToeScreen> createState() => _TicTacToeScreenState();
}

class _TicTacToeScreenState extends State<TicTacToeScreen> {
  bool _submitting = false;
  bool _hapticFired = false;

  @override
  void didUpdateWidget(TicTacToeScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.match.isFinished && !oldWidget.match.isFinished) {
      _hapticFired = false;
    }
    if (widget.match.isFinished && !_hapticFired) {
      _hapticFired = true;
      HapticFeedback.mediumImpact();
    }
  }

  Future<void> _handleTap(int cell) async {
    setState(() => _submitting = true);
    HapticFeedback.selectionClick();
    try {
      await widget.onMove(cell);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final match = widget.match;
    final board = (match.state['board'] as List).cast<String?>();
    final playerOrder = (match.state['playerOrder'] as List).cast<String>();
    final moveCount = match.state['moveCount'] as int;

    String markFor(String userId) => userId == playerOrder[0] ? 'X' : 'O';

    final currentTurnUserId = match.isFinished
        ? null
        : playerOrder[moveCount % 2];
    final isMyTurn = currentTurnUserId == widget.currentUserId;

    final opponent = match.players.firstWhere(
      (p) => p.userId != widget.currentUserId,
      orElse: () => match.players.first,
    );
    final winningLine = match.winnerUserId != null
        ? findWinningLine(board)
        : null;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Tic-Tac-Toe'),
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: widget.onExit,
        ),
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              _StatusBar(
                myMark: markFor(widget.currentUserId),
                opponentConnected: opponent.connected,
                isMyTurn: isMyTurn,
                finished: match.isFinished,
              ),
              if (widget.financial.isFinanciallyBacked) ...[
                const SizedBox(height: 8),
                _StakeStatusBar(stake: widget.financial.stake!),
              ],
              const SizedBox(height: 24),
              Expanded(
                child: Center(
                  child: TicTacToeBoard(
                    board: board,
                    markFor: markFor,
                    winningLine: winningLine,
                    enabled: isMyTurn && !match.isFinished && !_submitting,
                    onCellTap: _handleTap,
                  ),
                ),
              ),
              const SizedBox(height: 16),
              if (widget.lastRejection != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(
                    widget.lastRejection!,
                    style: const TextStyle(color: AppColors.error),
                    textAlign: TextAlign.center,
                  ),
                ),
              if (match.isFinished)
                widget.financial.settlement != null
                    ? _FinancialResultBanner(
                        currentUserId: widget.currentUserId,
                        settlement: widget.financial.settlement!,
                        onExit: widget.onExit,
                        onDispute: widget.onDispute,
                      )
                    : _ResultBanner(
                        won: match.winnerUserId == widget.currentUserId,
                        isDraw: match.resultIsDraw,
                        onExit: widget.onExit,
                      ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusBar extends StatelessWidget {
  const _StatusBar({
    required this.myMark,
    required this.opponentConnected,
    required this.isMyTurn,
    required this.finished,
  });

  final String myMark;
  final bool opponentConnected;
  final bool isMyTurn;
  final bool finished;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Icon(
            myMark == 'X' ? Icons.close_rounded : Icons.circle_outlined,
            color: myMark == 'X' ? AppColors.primary : AppColors.secondary,
          ),
          const SizedBox(width: 8),
          Text('You play $myMark'),
          const Spacer(),
          if (!opponentConnected && !finished) ...[
            const Icon(Icons.wifi_off, size: 16, color: AppColors.error),
            const SizedBox(width: 6),
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

class _ResultBanner extends StatelessWidget {
  const _ResultBanner({
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
        const SizedBox(height: 16),
        FilledButton(onPressed: onExit, child: const Text('Back to account')),
      ],
    );
  }
}

/// A small, unobtrusive strip showing this match's entry amount and
/// prize pool while it's in progress — the board stays the visual
/// priority; this never appears for free play (see
/// `TicTacToeScreen.financial`'s default).
class _StakeStatusBar extends StatelessWidget {
  const _StakeStatusBar({required this.stake});

  final MatchStakeInfo stake;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          const Icon(
            Icons.payments_outlined,
            size: 14,
            color: AppColors.secondary,
          ),
          const SizedBox(width: 8),
          Text(
            'Entry ${formatMinorAmount(stake.stakeAmountMinor, currency: stake.currency)} · '
            'Pool ${formatMinorAmount(stake.poolAmountMinor, currency: stake.currency)}',
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceMuted),
          ),
        ],
      ),
    );
  }
}

/// The financial-aware counterpart of [_ResultBanner], shown instead of
/// it once this match has a [SettlementInfo] (i.e. it was staked). Never
/// invoked for free play — see the `settlement != null` guard in
/// `TicTacToeScreen.build`, which keeps the plain [_ResultBanner]
/// untouched and byte-for-byte unchanged for every free-play match.
class _FinancialResultBanner extends StatelessWidget {
  const _FinancialResultBanner({
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
        const SizedBox(height: 8),
        Text(
          subtitle,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: 16),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (onDispute != null) ...[
              OutlinedButton(
                onPressed: () => _fileDispute(context),
                child: const Text('Dispute'),
              ),
              const SizedBox(width: 12),
            ],
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
      builder: (context) => const _DisputeReasonDialog(),
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

/// Collects a dispute reason (>=10 characters — the server enforces
/// this too; see `POST /matches/:id/dispute` in docs/api/README.md).
/// Mirrors `game_lobby_screen.dart`'s `_ChallengeUsernameDialog` pattern.
class _DisputeReasonDialog extends StatefulWidget {
  const _DisputeReasonDialog();

  @override
  State<_DisputeReasonDialog> createState() => _DisputeReasonDialogState();
}

class _DisputeReasonDialogState extends State<_DisputeReasonDialog> {
  final _controller = TextEditingController();

  bool get _isValid => _controller.text.trim().length >= 10;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('File a dispute'),
      content: TextField(
        controller: _controller,
        autofocus: true,
        maxLines: 3,
        decoration: const InputDecoration(
          labelText: 'What went wrong?',
          helperText: 'At least 10 characters.',
        ),
        onChanged: (_) => setState(() {}),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _isValid
              ? () => Navigator.of(context).pop(_controller.text.trim())
              : null,
          child: const Text('Submit'),
        ),
      ],
    );
  }
}
