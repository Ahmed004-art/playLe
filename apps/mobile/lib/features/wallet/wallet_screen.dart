import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_colors.dart';
import '../../core/wallet/money_format.dart';
import '../../core/wallet/wallet_controller.dart';
import '../../core/wallet/wallet_models.dart';
import '../../core/wallet/wallet_state.dart';

/// The wallet home screen: balances, deposit/withdraw actions, and recent
/// transaction history. Never renders a balance that didn't come from the
/// API — [WalletLoading]/[WalletLoadError] are handled explicitly rather
/// than defaulting to a stale or zero value.
class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key, required this.walletController});

  final WalletController walletController;

  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  @override
  void initState() {
    super.initState();
    widget.walletController.refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Wallet')),
      body: ListenableBuilder(
        listenable: widget.walletController,
        builder: (context, _) {
          final state = widget.walletController.state;

          return switch (state) {
            WalletLoading() => const Center(child: CircularProgressIndicator()),
            WalletLoadError(message: final message) => _ErrorView(
              message: message,
              onRetry: widget.walletController.refresh,
            ),
            WalletLoaded(
              wallet: final wallet,
              transactions: final transactions,
            ) =>
              RefreshIndicator(
                onRefresh: widget.walletController.refresh,
                child: ListView(
                  padding: const EdgeInsets.all(24),
                  children: [
                    _BalanceCard(wallet: wallet),
                    const SizedBox(height: 24),
                    Row(
                      children: [
                        Expanded(
                          child: FilledButton(
                            onPressed: () => context.push('/wallet/deposit'),
                            child: const Text('Deposit'),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: OutlinedButton(
                            onPressed: () => context.push('/wallet/withdraw'),
                            child: const Text('Withdraw'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 32),
                    Text(
                      'Recent activity',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 8),
                    if (transactions.isEmpty)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        child: Text(
                          'No transactions yet.',
                          style: Theme.of(context).textTheme.bodyMedium
                              ?.copyWith(color: AppColors.onSurfaceMuted),
                        ),
                      )
                    else
                      ...transactions.map(
                        (entry) => _LedgerEntryRow(entry: entry),
                      ),
                  ],
                ),
              ),
          };
        },
      ),
    );
  }
}

class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.wallet});

  final Wallet wallet;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Available balance',
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceMuted),
          ),
          const SizedBox(height: 4),
          Text(
            formatMinorAmount(
              wallet.availableBalanceMinor,
              currency: wallet.currency,
            ),
            style: Theme.of(context).textTheme.headlineMedium?.copyWith(
              color: AppColors.onBackground,
              fontWeight: FontWeight.bold,
            ),
          ),
          if (BigInt.parse(wallet.heldBalanceMinor) > BigInt.zero) ...[
            const SizedBox(height: 16),
            Text(
              'Held (pending withdrawal): '
              '${formatMinorAmount(wallet.heldBalanceMinor, currency: wallet.currency)}',
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceMuted),
            ),
          ],
        ],
      ),
    );
  }
}

class _LedgerEntryRow extends StatelessWidget {
  const _LedgerEntryRow({required this.entry});

  final LedgerEntry entry;

  @override
  Widget build(BuildContext context) {
    final availableDelta = BigInt.parse(entry.availableDeltaMinor);
    final heldDelta = BigInt.parse(entry.heldDeltaMinor);
    final netDelta = availableDelta + heldDelta;
    final isCredit = netDelta >= BigInt.zero;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(entry.type, style: Theme.of(context).textTheme.bodyMedium),
                Text(
                  '${entry.createdAt.toLocal()}'.split('.').first,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: AppColors.onSurfaceMuted,
                  ),
                ),
              ],
            ),
          ),
          Text(
            formatMinorAmount(
              netDelta.abs().toString(),
              currency: entry.currency,
            ),
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: isCredit ? AppColors.secondary : AppColors.error,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            OutlinedButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}
