import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/errors/app_exception.dart';
import '../../core/theme/app_colors.dart';
import '../../core/wallet/wallet_controller.dart';
import '../../core/wallet/wallet_models.dart';
import 'payment_status.dart';

/// Deposit amount entry. The minimum deposit (Le5) is enforced
/// server-side — this screen's own check is a UX convenience only, never
/// the actual boundary.
///
/// Once created, a deposit may come back with `paymentInstructions` — a
/// USSD "Payment Code" the user must dial themselves on their own phone
/// to actually pay (see docs/decisions/ADR-019-production-payments.md).
/// PlayLe never completes this step automatically, so the instructions
/// are shown prominently with an explicit "you must do this" framing.
/// Since there's no push channel for deposit status, this screen polls
/// `GET /deposits/:id` on a short timer while the deposit is `PENDING` so
/// a later webhook-driven `COMPLETED`/`EXPIRED`/`FAILED` is picked up
/// without the user having to leave and come back.
class DepositScreen extends StatefulWidget {
  const DepositScreen({super.key, required this.walletController});

  final WalletController walletController;

  @override
  State<DepositScreen> createState() => _DepositScreenState();
}

class _DepositScreenState extends State<DepositScreen> {
  final _formKey = GlobalKey<FormState>();
  final _amountController = TextEditingController();

  bool _submitting = false;
  String? _errorMessage;
  Deposit? _deposit;
  Timer? _pollTimer;

  @override
  void dispose() {
    _pollTimer?.cancel();
    _amountController.dispose();
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

      final deposit = await widget.walletController.deposit(
        amountMinor: amountMinor,
      );
      setState(() => _deposit = deposit);
      _startPollingIfNeeded();
    } on AppException catch (e) {
      setState(() => _errorMessage = e.message);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  void _startPollingIfNeeded() {
    _pollTimer?.cancel();
    final deposit = _deposit;
    if (deposit == null || deposit.isTerminal) return;

    _pollTimer = Timer.periodic(const Duration(seconds: 4), (_) async {
      try {
        final updated = await widget.walletController.fetchDeposit(deposit.id);
        if (!mounted) return;
        setState(() => _deposit = updated);
        if (updated.isTerminal) {
          _pollTimer?.cancel();
          // A COMPLETED deposit changed the wallet balance — refresh it.
          if (updated.status == 'COMPLETED') {
            await widget.walletController.refresh();
          }
        }
      } catch (_) {
        // A transient polling failure isn't worth surfacing as an error —
        // the next tick (or a manual app restart) will pick it up again.
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final deposit = _deposit;

    return Scaffold(
      appBar: AppBar(title: const Text('Deposit')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (deposit == null)
                ..._buildForm(context)
              else ...[
                _DepositStatusCard(deposit: deposit),
                const SizedBox(height: 24),
                OutlinedButton(
                  onPressed: () {
                    _pollTimer?.cancel();
                    setState(() {
                      _deposit = null;
                      _amountController.clear();
                    });
                  },
                  child: const Text('Make another deposit'),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _buildForm(BuildContext context) {
    return [
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
                if (parsed < 5) return 'Minimum deposit is Le5';
                return null;
              },
            ),
            if (_errorMessage != null) ...[
              const SizedBox(height: 16),
              Text(
                _errorMessage!,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
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
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Deposit'),
            ),
          ],
        ),
      ),
    ];
  }
}

class _DepositStatusCard extends StatelessWidget {
  const _DepositStatusCard({required this.deposit});

  final Deposit deposit;

  @override
  Widget build(BuildContext context) {
    final presentation = depositStatusPresentation(deposit.status);
    final instructions = deposit.paymentInstructions;
    final ussdCode = instructions?.ussdCode;

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
                'Deposit requested',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              StatusBadge(label: presentation.label, color: presentation.color),
            ],
          ),
          const SizedBox(height: 12),
          if (ussdCode != null && ussdCode.isNotEmpty) ...[
            Text(
              'Dial this code on your phone now to pay',
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceMuted),
            ),
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(vertical: 16),
              decoration: BoxDecoration(
                color: AppColors.background,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.secondary),
              ),
              child: Text(
                ussdCode,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 32,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 2,
                  color: AppColors.secondary,
                ),
              ),
            ),
            if (instructions?.expiresAt != null) ...[
              const SizedBox(height: 8),
              Text(
                'Expires at ${instructions!.expiresAt!.toLocal()}'
                    .split('.')
                    .first,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: AppColors.onSurfaceMuted,
                ),
              ),
            ],
            const SizedBox(height: 12),
            Text(
              'This is a real action you need to take on your phone — '
              'PlayLe does not complete this payment for you. Your '
              'balance updates automatically once the payment is '
              'confirmed.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ] else
            Text(
              presentation.description,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          if (deposit.status == 'PENDING') ...[
            const SizedBox(height: 16),
            const Row(
              children: [
                SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                SizedBox(width: 12),
                Expanded(child: Text('Checking for an update…')),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
