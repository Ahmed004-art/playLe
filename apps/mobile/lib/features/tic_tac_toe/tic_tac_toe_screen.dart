import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/match/match_models.dart';
import '../../core/theme/app_colors.dart';
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
  });

  final MatchInfo match;
  final String currentUserId;
  final String? lastRejection;
  final Future<void> Function(int cell) onMove;
  final VoidCallback onExit;

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
                _ResultBanner(
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
