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
import 'checkers_board.dart';
import 'checkers_models.dart';

/// The polished Checkers experience: board, turn/connection indicators,
/// multi-jump continuation guidance, and victory/draw/defeat
/// presentation. Purely a renderer of server-pushed [match] state (see
/// ADR-008) — tapping a square only ever *attempts* a move; the server
/// is the sole authority on whether it's legal (see
/// docs/decisions/ADR-022-checkers-game-module.md). Reuses the same
/// generic chrome (`core/match/widgets/`) Tic-Tac-Toe uses.
class CheckersScreen extends StatefulWidget {
  const CheckersScreen({
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
  final Future<void> Function(Coord from, Coord to) onMove;
  final VoidCallback onExit;

  /// Resign/draw-offer actions (Phase 9 — ADR-024) — shown/hidden per
  /// `match.supportsResignation`/`supportsDraws`, never assumed.
  final Future<void> Function() onResign;
  final Future<void> Function() onOfferDraw;
  final Future<void> Function() onAcceptDraw;
  final Future<void> Function() onRejectDraw;
  final MatchFinancialInfo financial;
  final Future<void> Function(String reason)? onDispute;

  @override
  State<CheckersScreen> createState() => _CheckersScreenState();
}

class _CheckersScreenState extends State<CheckersScreen> {
  bool _submitting = false;
  bool _hapticFired = false;
  Coord? _selected;

  @override
  void didUpdateWidget(CheckersScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.match.isFinished && !oldWidget.match.isFinished) {
      _hapticFired = false;
    }
    if (widget.match.isFinished && !_hapticFired) {
      _hapticFired = true;
      HapticFeedback.mediumImpact();
    }
    // A push always reflects the latest authoritative state — any
    // selection made against the previous state is stale.
    if (oldWidget.match.stateVersion != widget.match.stateVersion) {
      _selected = null;
    }
  }

  void _handleSquareTap(CheckersBoardState state, Coord coord) {
    // A forced multi-jump continuation locks selection to that one piece
    // — tapping anywhere else is simply ignored rather than treated as a
    // (futile) attempt to switch pieces.
    final forced = state.mustContinueFrom;
    if (forced != null) {
      if (coord == forced) return;
      _submitMove(forced, coord);
      return;
    }

    final tappedPiece = state.at(coord);
    if (_selected == null) {
      if (tappedPiece != null && tappedPiece.owner == widget.currentUserId) {
        setState(() => _selected = coord);
      }
      return;
    }
    if (coord == _selected) {
      setState(() => _selected = null);
      return;
    }
    if (tappedPiece != null && tappedPiece.owner == widget.currentUserId) {
      setState(() => _selected = coord);
      return;
    }
    _submitMove(_selected!, coord);
  }

  Future<void> _submitMove(Coord from, Coord to) async {
    setState(() {
      _submitting = true;
      _selected = null;
    });
    HapticFeedback.selectionClick();
    try {
      await widget.onMove(from, to);
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
    final state = CheckersBoardState.fromJson(match.state);
    final isPlayerZero = widget.currentUserId == state.playerOrder[0];

    final isMyTurn =
        !match.isFinished && state.currentTurn == widget.currentUserId;
    final mustContinue = isMyTurn && state.mustContinueFrom != null;

    final opponent = match.players.firstWhere(
      (p) => p.userId != widget.currentUserId,
      orElse: () => match.players.first,
    );

    final enabled = isMyTurn && !match.isFinished && !_submitting;
    final selected = mustContinue ? state.mustContinueFrom : _selected;
    final legalDestinations = (enabled && selected != null)
        ? findLegalDestinations(state, selected).toSet()
        : const <Coord>{};

    return Scaffold(
      appBar: AppBar(
        title: const Text('Checkers'),
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
                    Container(
                      width: 14,
                      height: 14,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: isPlayerZero
                            ? AppColors.pieceP1
                            : AppColors.pieceP2,
                      ),
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    const Text('Your pieces'),
                  ],
                ),
                opponentConnected: opponent.connected,
                isMyTurn: isMyTurn,
                finished: match.isFinished,
                turnDeadlineAt: match.turnDeadlineAt,
              ),
              if (mustContinue)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.sm),
                  child: Text(
                    'Continue your jump — another capture is available.',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: AppColors.kingAccent,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
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
                  child: CheckersBoard(
                    state: state,
                    selected: selected,
                    legalDestinations: legalDestinations,
                    enabled: enabled,
                    flipped: !isPlayerZero,
                    onSquareTap: (coord) => _handleSquareTap(state, coord),
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
