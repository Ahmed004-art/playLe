import 'package:flutter/material.dart';

import '../../core/errors/app_exception.dart';
import '../../core/theme/app_colors.dart';
import '../../core/wallet/wallet_controller.dart';

/// Deposit amount entry. The minimum deposit (Le5) is enforced
/// server-side — this screen's own check is a UX convenience only, never
/// the actual boundary. Deposits don't settle instantly yet (no live
/// payment-provider connection — see docs/development/MONIME_SETUP.md),
/// so the success state says so plainly rather than implying the money
/// has already arrived.
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
  String? _successMessage;

  @override
  void dispose() {
    _amountController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() {
      _submitting = true;
      _errorMessage = null;
      _successMessage = null;
    });

    try {
      final amountLeones = double.parse(_amountController.text.trim());
      final amountMinor = (amountLeones * 100).round().toString();

      await widget.walletController.deposit(amountMinor: amountMinor);

      setState(() {
        _successMessage =
            'Deposit recorded and awaiting confirmation. PlayLe does not '
            'yet have a live mobile-money connection, so this is in '
            'manual/test mode — it will not credit your balance '
            'automatically.';
      });
    } on AppException catch (e) {
      setState(() => _errorMessage = e.message);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Deposit')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Form(
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
                if (_successMessage != null) ...[
                  const SizedBox(height: 16),
                  Text(
                    _successMessage!,
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: AppColors.secondary),
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
        ),
      ),
    );
  }
}
