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
import '../../core/theme/app_spacing.dart';
import 'tic_tac_toe_board.dart';

/// The polished Tic-Tac-Toe experience: board, turn/connection
/// indicators, and victory/draw/defeat presentation. Purely a renderer
/// of server-pushed [match] state (see ADR-008) — it never decides whose
/// turn it is or who won; it only *displays* what the board already
/// shows and what `match.winnerUserId`/`resultIsDraw` already say. The
/// generic chrome (status bar, stake strip, result banners, dispute
/// dialog) lives in `core/match/widgets/` (Phase 7) and is shared with
/// Checkers — only the board and the "You play X/O" indicator below are
/// actually Tic-Tac-Toe-specific.
class TicTacToeScreen extends StatefulWidget {
  const TicTacToeScreen({
    super.key,
    required this.match,
    required this.currentUserId,
    required this.lastRejection,
    required this.onMove,
    required this.onExit,
    required this.onResign,
    required this.onOfferDraw,
    required this.onAcceptDraw,
    required this.onRejectDraw,
    this.financial = const MatchFinancialInfo.empty(),
    this.onDispute,
  });

  final MatchInfo match;
  final String currentUserId;
  final String? lastRejection;
  final Future<void> Function(int cell) onMove;
  final VoidCallback onExit;

  /// Resign/draw-offer actions (Phase 9 — ADR-024) — shown/hidden per
  /// `match.supportsResignation`/`supportsDraws`, never assumed.
  final Future<void> Function() onResign;
  final Future<void> Function() onOfferDraw;
  final Future<void> Function() onAcceptDraw;
  final Future<void> Function() onRejectDraw;

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

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _submitting = true);
    try {
      await action();
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _handleResign() async {
    final confirmed = await showResignConfirmationDialog(context);
    if (!confirmed || !mounted) return;
    await _run(widget.onResign);
  }

  @override
  Widget build(BuildContext context) {
    final match = widget.match;
    final board = (match.state['board'] as List).cast<String?>();
    final playerOrder = (match.state['playerOrder'] as List).cast<String>();
    final moveCount = match.state['moveCount'] as int;

    String markFor(String userId) => userId == playerOrder[0] ? 'X' : 'O';
    final myMark = markFor(widget.currentUserId);

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
          padding: const EdgeInsets.all(AppSpacing.xl),
          child: Column(
            children: [
              MatchStatusBar(
                leading: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      myMark == 'X'
                          ? Icons.close_rounded
                          : Icons.circle_outlined,
                      color: myMark == 'X'
                          ? AppColors.primary
                          : AppColors.secondary,
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Text('You play $myMark'),
                  ],
                ),
                opponentConnected: opponent.connected,
                isMyTurn: isMyTurn,
                finished: match.isFinished,
                turnDeadlineAt: match.turnDeadlineAt,
              ),
              if (widget.financial.isFinanciallyBacked) ...[
                const SizedBox(height: AppSpacing.sm),
                MatchStakeStatusBar(stake: widget.financial.stake!),
              ],
              if (!match.isFinished) ...[
                if (match.pendingDrawOfferByUserId != null)
                  DrawOfferBanner(
                    isMine:
                        match.pendingDrawOfferByUserId == widget.currentUserId,
                    busy: _submitting,
                    onAccept: () => _run(widget.onAcceptDraw),
                    onReject: () => _run(widget.onRejectDraw),
                  )
                else
                  MatchActionBar(
                    supportsResignation: match.supportsResignation,
                    supportsDraws: match.supportsDraws,
                    busy: _submitting,
                    onResign: _handleResign,
                    onOfferDraw: () => _run(widget.onOfferDraw),
                  ),
              ],
              const SizedBox(height: AppSpacing.xl),
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
              const SizedBox(height: AppSpacing.lg),
              if (widget.lastRejection != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.md),
                  child: Text(
                    widget.lastRejection!,
                    style: const TextStyle(color: AppColors.error),
                    textAlign: TextAlign.center,
                  ),
                ),
              if (match.isFinished)
                widget.financial.settlement != null
                    ? FinancialResultBanner(
                        currentUserId: widget.currentUserId,
                        settlement: widget.financial.settlement!,
                        onExit: widget.onExit,
                        onDispute: widget.onDispute,
                      )
                    : MatchResultBanner(
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
