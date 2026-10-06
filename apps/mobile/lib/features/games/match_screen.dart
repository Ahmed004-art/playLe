import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/auth/auth_state.dart';
import '../../core/disputes/disputes_controller.dart';
import '../../core/match/match_controller.dart';
import '../../core/match/match_state.dart';
import '../../core/wallet/wallet_controller.dart';
import '../tic_tac_toe/tic_tac_toe_screen.dart';
import 'stake_confirm_screen.dart';

/// Generic match entry point: loads the authoritative match, then hands
/// rendering off to the game-specific screen for `match.gameId` — the
/// only place that dispatch happens. Adding a future game means adding
/// one more case here, never touching the generic match/matchmaking/
/// challenge layer (see docs/decisions/ADR-015-game-module-architecture.md).
class MatchScreen extends StatefulWidget {
  const MatchScreen({
    super.key,
    required this.matchId,
    required this.authController,
    required this.matchController,
    required this.walletController,
    required this.disputesController,
  });

  final String matchId;
  final AuthController authController;
  final MatchController matchController;
  final WalletController walletController;
  final DisputesController disputesController;

  @override
  State<MatchScreen> createState() => _MatchScreenState();
}

class _MatchScreenState extends State<MatchScreen> {
  @override
  void initState() {
    super.initState();
    widget.matchController.loadMatch(widget.matchId);
  }

  @override
  void dispose() {
    widget.matchController.leaveRealtimeRoom();
    widget.matchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final authState = widget.authController.state;
    final currentUserId = authState is AuthAuthenticated
        ? authState.user.id
        : null;

    return ListenableBuilder(
      listenable: widget.matchController,
      builder: (context, _) {
        final state = widget.matchController.state;

        return switch (state) {
          MatchViewLoading() => const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          ),
          MatchViewError(message: final message) => Scaffold(
            appBar: AppBar(),
            body: Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(message, textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    OutlinedButton(
                      onPressed: () =>
                          widget.matchController.loadMatch(widget.matchId),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            ),
          ),
          MatchViewLoaded(
            match: final match,
            lastRejection: final rejection,
            financial: final financial,
          ) =>
            currentUserId == null
                ? const Scaffold(body: Center(child: Text('Not signed in.')))
                : (match.status == 'WAITING' && financial.isFinanciallyBacked)
                ? StakeConfirmScreen(
                    match: match,
                    stake: financial.stake!,
                    currentUserId: currentUserId,
                    walletController: widget.walletController,
                    onConfirm: widget.matchController.confirmStake,
                    onExit: () => context.go('/account'),
                  )
                : switch (match.gameId) {
                    'tic_tac_toe' => TicTacToeScreen(
                      match: match,
                      currentUserId: currentUserId,
                      lastRejection: rejection,
                      financial: financial,
                      onMove: (cell) =>
                          widget.matchController.submitMove({'cell': cell}),
                      onExit: () => context.go('/account'),
                      onDispute: (reason) async {
                        await widget.disputesController.create(
                          match.id,
                          reason,
                        );
                      },
                    ),
                    _ => Scaffold(
                      appBar: AppBar(),
                      body: Center(
                        child: Text('Unsupported game: ${match.gameId}'),
                      ),
                    ),
                  },
        };
      },
    );
  }
}
