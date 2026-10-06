import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/errors/app_exception.dart';
import '../../core/match/match_models.dart';
import '../../core/match_stakes/match_stake_models.dart';
import '../../core/theme/app_colors.dart';
import '../../core/wallet/money_format.dart';
import '../../core/wallet/wallet_controller.dart';
import '../../core/wallet/wallet_state.dart';

/// Shown once a financially-backed match has formed but hasn't started
/// yet (`Match.status == 'WAITING'` — see
/// docs/decisions/ADR-018-financial-state-machines.md). The player
/// reviews the entry amount, prize pool, and potential win, then taps
/// "Confirm Entry" to call `POST /matches/:id/stake/confirm` and hold
/// their stake. This screen never navigates itself — once every player
/// has confirmed, the server flips the match to `ACTIVE` and the
/// existing `match:state` push (re-fetched by `MatchController`) causes
/// `MatchScreen` to swap this screen out for the game itself.
class StakeConfirmScreen extends StatefulWidget {
  const StakeConfirmScreen({
    super.key,
    required this.match,
    required this.stake,
    required this.currentUserId,
    required this.walletController,
    required this.onConfirm,
    required this.onExit,
  });

  final MatchInfo match;
  final MatchStakeInfo stake;
  final String currentUserId;
  final WalletController walletController;
  final Future<void> Function() onConfirm;
  final VoidCallback onExit;

  @override
  State<StakeConfirmScreen> createState() => _StakeConfirmScreenState();
}

class _StakeConfirmScreenState extends State<StakeConfirmScreen> {
  bool _confirming = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.walletController.refresh();
  }

  bool get _hasConfirmed => widget.stake.hasConfirmed(widget.currentUserId);

  Future<void> _confirm() async {
    setState(() {
      _confirming = true;
      _error = null;
    });
    HapticFeedback.selectionClick();
    try {
      await widget.onConfirm();
      if (mounted) HapticFeedback.mediumImpact();
    } on AppException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _confirming = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final stake = widget.stake;
    // Fee/payout preview — an exact client-side replication of the
    // server's own fixed 10% rule (see
    // docs/decisions/ADR-017-deterministic-settlement.md), computed only
    // for display using BigInt (never a double). The server remains the
    // sole authority over the actual settlement once the match ends.
    final pool = BigInt.parse(stake.poolAmountMinor);
    final fee = pool * BigInt.from(10) ~/ BigInt.from(100);
    final potentialWin = pool - fee;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Confirm Entry'),
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: widget.onExit,
        ),
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: ListView(
                  children: [
                    const Icon(
                      Icons.payments_rounded,
                      size: 56,
                      color: AppColors.secondary,
                    ),
                    const SizedBox(height: 16),
                    Text(
                      'This match is staked',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    const SizedBox(height: 24),
                    _SummaryRow(
                      label: 'Your entry',
                      value: formatMinorAmount(
                        stake.stakeAmountMinor,
                        currency: stake.currency,
                      ),
                    ),
                    _SummaryRow(
                      label: 'Prize pool',
                      value: formatMinorAmount(
                        stake.poolAmountMinor,
                        currency: stake.currency,
                      ),
                    ),
                    _SummaryRow(
                      label: 'Platform fee (10%)',
                      value: formatMinorAmount(
                        fee.toString(),
                        currency: stake.currency,
                      ),
                    ),
                    _SummaryRow(
                      label: 'If you win',
                      value: formatMinorAmount(
                        potentialWin.toString(),
                        currency: stake.currency,
                      ),
                      emphasize: true,
                    ),
                    const Divider(height: 32),
                    ListenableBuilder(
                      listenable: widget.walletController,
                      builder: (context, _) {
                        final walletState = widget.walletController.state;
                        final balance = walletState is WalletLoaded
                            ? formatMinorAmount(
                                walletState.wallet.availableBalanceMinor,
                                currency: walletState.wallet.currency,
                              )
                            : '—';
                        return _SummaryRow(
                          label: 'Your wallet balance',
                          value: balance,
                        );
                      },
                    ),
                    const SizedBox(height: 24),
                    Text(
                      "If the match ends in a draw, or is cancelled before "
                      "it starts, your stake is refunded in full. If you "
                      "lose, your entry becomes part of the winner's prize.",
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: AppColors.onSurfaceMuted,
                      ),
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: 16),
                      Text(
                        _error!,
                        style: const TextStyle(color: AppColors.error),
                        textAlign: TextAlign.center,
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 16),
              if (_hasConfirmed)
                const _WaitingForOpponentBanner()
              else
                FilledButton(
                  onPressed: _confirming ? null : _confirm,
                  child: _confirming
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : Text(
                          'Confirm Entry — '
                          '${formatMinorAmount(stake.stakeAmountMinor, currency: stake.currency)}',
                        ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SummaryRow extends StatelessWidget {
  const _SummaryRow({
    required this.label,
    required this.value,
    this.emphasize = false,
  });

  final String label;
  final String value;
  final bool emphasize;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            label,
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceMuted),
          ),
          Text(
            value,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
              color: emphasize ? AppColors.secondary : null,
              fontWeight: emphasize ? FontWeight.bold : FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _WaitingForOpponentBanner extends StatelessWidget {
  const _WaitingForOpponentBanner();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
      ),
      child: const Row(
        children: [
          SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          SizedBox(width: 16),
          Expanded(child: Text('Waiting for the other player to confirm…')),
        ],
      ),
    );
  }
}
