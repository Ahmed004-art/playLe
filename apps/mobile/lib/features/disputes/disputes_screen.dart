import 'package:flutter/material.dart';

import '../../core/disputes/dispute_models.dart';
import '../../core/disputes/disputes_controller.dart';
import '../../core/disputes/disputes_state.dart';
import '../../core/theme/app_colors.dart';

/// Lists the authenticated user's own disputes — mirrors
/// `game_lobby_screen.dart`'s challenge-list pattern. Filing a new
/// dispute happens from a completed match's result screen (see
/// `features/tic_tac_toe/tic_tac_toe_screen.dart`'s `_FinancialResultBanner`);
/// this screen is read-only.
class DisputesScreen extends StatefulWidget {
  const DisputesScreen({super.key, required this.disputesController});

  final DisputesController disputesController;

  @override
  State<DisputesScreen> createState() => _DisputesScreenState();
}

class _DisputesScreenState extends State<DisputesScreen> {
  @override
  void initState() {
    super.initState();
    widget.disputesController.refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Disputes')),
      body: ListenableBuilder(
        listenable: widget.disputesController,
        builder: (context, _) {
          final state = widget.disputesController.state;

          return switch (state) {
            DisputesLoading() => const Center(
              child: CircularProgressIndicator(),
            ),
            DisputesLoadError(message: final message) => Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(message, textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    OutlinedButton(
                      onPressed: widget.disputesController.refresh,
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            ),
            DisputesLoaded(disputes: final disputes) =>
              disputes.isEmpty
                  ? const Center(child: Text("You haven't filed any disputes."))
                  : RefreshIndicator(
                      onRefresh: widget.disputesController.refresh,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: disputes.length,
                        itemBuilder: (context, index) =>
                            _DisputeCard(dispute: disputes[index]),
                      ),
                    ),
          };
        },
      ),
    );
  }
}

class _DisputeCard extends StatelessWidget {
  const _DisputeCard({required this.dispute});

  final DisputeInfo dispute;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    'Match ${dispute.matchId.substring(0, dispute.matchId.length.clamp(0, 8))}',
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
                _StatusChip(status: dispute.status),
              ],
            ),
            const SizedBox(height: 8),
            Text(dispute.reason),
            if (dispute.resolution != null) ...[
              const SizedBox(height: 8),
              Text(
                'Resolution: ${dispute.resolution}',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: AppColors.onSurfaceMuted,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      'OPEN' || 'UNDER_REVIEW' => AppColors.secondary,
      'UPHELD' || 'REFUNDED' => AppColors.primary,
      _ => AppColors.onSurfaceMuted,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.18),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        status,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: color,
          fontWeight: FontWeight.bold,
        ),
      ),
    );
  }
}
