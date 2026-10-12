import 'package:flutter/material.dart';

import '../../core/errors/app_exception.dart';
import '../../core/responsible_gaming/responsible_gaming_controller.dart';
import '../../core/responsible_gaming/responsible_gaming_models.dart';
import '../../core/responsible_gaming/responsible_gaming_state.dart';
import '../../core/theme/app_colors.dart';
import '../../core/wallet/money_format.dart';

/// The exact phrase a user must type to confirm self-exclusion — a
/// deliberate extra step beyond a single tap, since this action is
/// permanent and irreversible through this app (see
/// docs/decisions/ADR-021-eligibility-and-responsible-gaming.md).
const selfExclusionConfirmationPhrase = 'EXCLUDE ME';

/// Shows the self-exclusion warning dialog and returns `true` only if
/// the user both typed [selfExclusionConfirmationPhrase] exactly and
/// tapped "Permanently exclude myself". Extracted as a top-level
/// function (rather than inlined in the screen) so it can be tested in
/// isolation from any network call.
Future<bool> showSelfExclusionConfirmationDialog(BuildContext context) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (context) => const _SelfExclusionDialog(),
  );
  return result ?? false;
}

class _SelfExclusionDialog extends StatefulWidget {
  const _SelfExclusionDialog();

  @override
  State<_SelfExclusionDialog> createState() => _SelfExclusionDialogState();
}

class _SelfExclusionDialogState extends State<_SelfExclusionDialog> {
  final _controller = TextEditingController();
  bool _matches = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(() {
      final matches =
          _controller.text.trim() == selfExclusionConfirmationPhrase;
      if (matches != _matches) setState(() => _matches = matches);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Permanently self-exclude?'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'This permanently blocks deposits and real-money play on '
              'your account.',
              style: TextStyle(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 12),
            const Text(
              'There is no way to undo this through PlayLe — not in this '
              'app, and not by contacting support in any way this app '
              'offers. Once confirmed, it cannot be lifted.',
            ),
            const SizedBox(height: 12),
            const Text(
              'Withdrawals are NOT blocked — you can still withdraw any '
              'funds already in your wallet.',
            ),
            const SizedBox(height: 16),
            Text('Type "$selfExclusionConfirmationPhrase" to confirm:'),
            const SizedBox(height: 8),
            TextField(
              controller: _controller,
              autofocus: true,
              decoration: const InputDecoration(
                hintText: selfExclusionConfirmationPhrase,
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: AppColors.error),
          onPressed: _matches ? () => Navigator.of(context).pop(true) : null,
          child: const Text('Permanently exclude myself'),
        ),
      ],
    );
  }
}

/// Deposit/stake/loss limit setting + self-exclusion + cooling-off —
/// mirrors `apps/api/src/eligibility/responsible-gaming.controller.ts`.
class ResponsibleGamingScreen extends StatefulWidget {
  const ResponsibleGamingScreen({super.key, required this.controller});

  final ResponsibleGamingController controller;

  @override
  State<ResponsibleGamingScreen> createState() =>
      _ResponsibleGamingScreenState();
}

class _ResponsibleGamingScreenState extends State<ResponsibleGamingScreen> {
  final _depositLimitController = TextEditingController();
  final _stakeLimitController = TextEditingController();
  final _lossLimitController = TextEditingController();
  final _customMinutesController = TextEditingController();

  bool _busy = false;

  @override
  void initState() {
    super.initState();
    widget.controller.refresh();
  }

  @override
  void dispose() {
    _depositLimitController.dispose();
    _stakeLimitController.dispose();
    _lossLimitController.dispose();
    _customMinutesController.dispose();
    super.dispose();
  }

  String? _toMinorString(String leoneText) {
    final parsed = double.tryParse(leoneText.trim());
    if (parsed == null || parsed <= 0) return null;
    return (parsed * 100).round().toString();
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
    } on AppException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _selfExclude() async {
    final confirmed = await showSelfExclusionConfirmationDialog(context);
    if (!confirmed || !mounted) return;
    await _run(widget.controller.selfExclude);
  }

  Future<void> _coolingOff(int minutes) =>
      _run(() => widget.controller.startCoolingOff(minutes));

  Future<void> _setDepositLimit() async {
    final minor = _toMinorString(_depositLimitController.text);
    if (minor == null) return;
    await _run(() => widget.controller.setDepositLimit(minor));
  }

  Future<void> _setStakeLimit() async {
    final minor = _toMinorString(_stakeLimitController.text);
    if (minor == null) return;
    await _run(() => widget.controller.setStakeLimit(minor));
  }

  Future<void> _setLossLimit() async {
    final minor = _toMinorString(_lossLimitController.text);
    if (minor == null) return;
    await _run(() => widget.controller.setLossLimit(minor));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Responsible gaming')),
      body: ListenableBuilder(
        listenable: widget.controller,
        builder: (context, _) {
          final state = widget.controller.state;
          return switch (state) {
            ResponsibleGamingLoading() => const Center(
              child: CircularProgressIndicator(),
            ),
            ResponsibleGamingLoadError(message: final message) => Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(message, textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    OutlinedButton(
                      onPressed: widget.controller.refresh,
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            ),
            ResponsibleGamingLoaded() => _buildLoaded(context, state),
          };
        },
      ),
    );
  }

  Widget _buildLoaded(BuildContext context, ResponsibleGamingLoaded state) {
    return RefreshIndicator(
      onRefresh: widget.controller.refresh,
      child: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          Text(
            'Current restrictions',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          if (state.restrictions.isEmpty)
            Text(
              'No active restrictions.',
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceMuted),
            )
          else
            for (final r in state.restrictions) _RestrictionRow(restriction: r),
          const Divider(height: 32),
          if (state.isSelfExcluded) ...[
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: AppColors.error.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(12),
              ),
              child: const Text(
                'Your account is permanently self-excluded from '
                'real-money play and deposits.',
              ),
            ),
          ] else ...[
            Text(
              'Self-exclusion',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            const Text(
              'Permanently block yourself from deposits and real-money '
              'play. This cannot be undone.',
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              style: OutlinedButton.styleFrom(foregroundColor: AppColors.error),
              onPressed: _busy ? null : _selfExclude,
              child: const Text('Self-exclude permanently'),
            ),
          ],
          const Divider(height: 32),
          Text('Cooling-off', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          const Text(
            'Take a temporary break from deposits and real-money play.',
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            children: [
              OutlinedButton(
                onPressed: _busy ? null : () => _coolingOff(24 * 60),
                child: const Text('1 day'),
              ),
              OutlinedButton(
                onPressed: _busy ? null : () => _coolingOff(7 * 24 * 60),
                child: const Text('1 week'),
              ),
              OutlinedButton(
                onPressed: _busy ? null : () => _coolingOff(30 * 24 * 60),
                child: const Text('1 month'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _customMinutesController,
                  decoration: const InputDecoration(
                    labelText: 'Custom duration (minutes)',
                  ),
                  keyboardType: TextInputType.number,
                ),
              ),
              const SizedBox(width: 12),
              FilledButton(
                onPressed: _busy
                    ? null
                    : () {
                        final minutes = int.tryParse(
                          _customMinutesController.text.trim(),
                        );
                        if (minutes != null && minutes > 0) {
                          _coolingOff(minutes);
                        }
                      },
                child: const Text('Start'),
              ),
            ],
          ),
          const Divider(height: 32),
          Text('Deposit limit', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          _LimitForm(
            controller: _depositLimitController,
            busy: _busy,
            onSubmit: _setDepositLimit,
            buttonLabel: 'Set deposit limit',
          ),
          const Divider(height: 32),
          Text('Stake limit', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          _LimitForm(
            controller: _stakeLimitController,
            busy: _busy,
            onSubmit: _setStakeLimit,
            buttonLabel: 'Set stake limit',
          ),
          const Divider(height: 32),
          Text('Loss limit', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Text(
            'Recorded and visible, but not yet enforced automatically at '
            'settlement.',
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceMuted),
          ),
          const SizedBox(height: 8),
          _LimitForm(
            controller: _lossLimitController,
            busy: _busy,
            onSubmit: _setLossLimit,
            buttonLabel: 'Set loss limit',
          ),
        ],
      ),
    );
  }
}

class _LimitForm extends StatelessWidget {
  const _LimitForm({
    required this.controller,
    required this.busy,
    required this.onSubmit,
    required this.buttonLabel,
  });

  final TextEditingController controller;
  final bool busy;
  final Future<void> Function() onSubmit;
  final String buttonLabel;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: TextField(
            controller: controller,
            decoration: const InputDecoration(
              labelText: 'Amount (Le)',
              prefixText: 'Le ',
            ),
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
          ),
        ),
        const SizedBox(width: 12),
        FilledButton(
          onPressed: busy ? null : onSubmit,
          child: Text(buttonLabel),
        ),
      ],
    );
  }
}

class _RestrictionRow extends StatelessWidget {
  const _RestrictionRow({required this.restriction});

  final RestrictionInfo restriction;

  @override
  Widget build(BuildContext context) {
    final limit = restriction.limitMinor;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Expanded(
            child: Text(
              '${restriction.type} (${restriction.status})'
              '${limit != null ? ' — ${formatMinorAmount(limit)}' : ''}',
            ),
          ),
        ],
      ),
    );
  }
}
