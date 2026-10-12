import 'package:flutter/material.dart';

import '../../core/errors/app_exception.dart';
import '../../core/theme/app_colors.dart';
import '../../core/wallet/wallet_controller.dart';
import '../../core/wallet/wallet_models.dart';
import 'payment_status.dart';

/// Withdrawal request entry. The minimum (Le5) and available-balance
/// checks are enforced server-side — this screen's own validation is a
/// UX convenience only. A submitted withdrawal holds the funds
/// immediately but requires admin approval before any payout is sent.
/// Once approved, the withdrawal moves to `PROCESSING` while a real
/// payout is submitted to the provider (Phase 6 — see
/// docs/decisions/ADR-019-production-payments.md) before a final
/// `COMPLETED`/`FAILED` — this screen's status card distinguishes all of
/// `PENDING_REVIEW`/`APPROVED`/`PROCESSING` rather than lumping them
/// together.
class WithdrawScreen extends StatefulWidget {
  const WithdrawScreen({super.key, required this.walletController});

  final WalletController walletController;

  @override
  State<WithdrawScreen> createState() => _WithdrawScreenState();
}

class _WithdrawScreenState extends State<WithdrawScreen> {
  final _formKey = GlobalKey<FormState>();
  final _amountController = TextEditingController();
  final _phoneController = TextEditingController();

  bool _submitting = false;
  bool _refreshingStatus = false;
  String? _errorMessage;
  Withdrawal? _withdrawal;

  @override
  void dispose() {
    _amountController.dispose();
    _phoneController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _submitting = true;
      _errorMessage = null;
    });

    try {
      final amountLeones = double.parse(_amountController.text.trim());
      final amountMinor = (amountLeones * 100).round().toString();

      final withdrawal = await widget.walletController.withdraw(
        amountMinor: amountMinor,
        destinationDetails: {
          'method': 'ORANGE_MONEY',
          'phoneNumber': _phoneController.text.trim(),
        },
      );

      setState(() {
        _withdrawal = withdrawal;
        _amountController.clear();
        _phoneController.clear();
      });
    } on AppException catch (e) {
      setState(() => _errorMessage = e.message);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _refreshStatus() async {
    final withdrawal = _withdrawal;
    if (withdrawal == null) return;
    setState(() => _refreshingStatus = true);
    try {
      final updated = await widget.walletController.fetchWithdrawal(
        withdrawal.id,
      );
      if (mounted) setState(() => _withdrawal = updated);
    } on AppException catch (e) {
      if (mounted) setState(() => _errorMessage = e.message);
    } finally {
      if (mounted) setState(() => _refreshingStatus = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final withdrawal = _withdrawal;

    return Scaffold(
      appBar: AppBar(title: const Text('Withdraw')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (withdrawal != null) ...[
                _WithdrawalStatusCard(
                  withdrawal: withdrawal,
                  refreshing: _refreshingStatus,
                  onRefresh: _refreshStatus,
                ),
                const SizedBox(height: 24),
                OutlinedButton(
                  onPressed: () => setState(() => _withdrawal = null),
                  child: const Text('Request another withdrawal'),
                ),
              ] else
                Form(
                  key: _formKey,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TextFormField(
                        controller: _amountController,
                        decoration: const InputDecoration(
                          labelText: 'Amount (Le)',
                          prefixText: 'Le ',
                        ),
                        keyboardType: const TextInputType.numberWithOptions(
                          decimal: true,
                        ),
                        validator: (value) {
                          final parsed = double.tryParse(value?.trim() ?? '');
                          if (parsed == null) return 'Enter a valid amount';
                          if (parsed < 5) return 'Minimum withdrawal is Le5';
                          return null;
                        },
                      ),
                      const SizedBox(height: 16),
                      TextFormField(
                        controller: _phoneController,
                        decoration: const InputDecoration(
                          labelText: 'Orange Money phone number',
                        ),
                        keyboardType: TextInputType.phone,
                        validator: (value) =>
                            (value == null || value.trim().isEmpty)
                            ? 'Required'
                            : null,
                      ),
                      if (_errorMessage != null) ...[
                        const SizedBox(height: 16),
                        Text(
                          _errorMessage!,
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(
                                color: Theme.of(context).colorScheme.error,
                              ),
                        ),
                      ],
                      const SizedBox(height: 24),
                      FilledButton(
                        onPressed: _submitting ? null : _submit,
                        child: _submitting
                            ? const SizedBox(
                                height: 18,
                                width: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Text('Request withdrawal'),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _WithdrawalStatusCard extends StatelessWidget {
  const _WithdrawalStatusCard({
    required this.withdrawal,
    required this.refreshing,
    required this.onRefresh,
  });

  final Withdrawal withdrawal;
  final bool refreshing;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    final presentation = withdrawalStatusPresentation(withdrawal.status);

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Withdrawal requested',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              StatusBadge(label: presentation.label, color: presentation.color),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            presentation.description,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          if (withdrawal.failureReason != null) ...[
            const SizedBox(height: 8),
            Text(
              withdrawal.failureReason!,
              style: const TextStyle(color: AppColors.error),
            ),
          ],
          const SizedBox(height: 16),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: refreshing ? null : onRefresh,
              child: refreshing
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Check for an update'),
            ),
          ),
        ],
      ),
    );
  }
}
