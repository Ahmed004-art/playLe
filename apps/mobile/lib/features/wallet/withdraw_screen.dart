import 'package:flutter/material.dart';

import '../../core/errors/app_exception.dart';
import '../../core/theme/app_colors.dart';
import '../../core/wallet/wallet_controller.dart';

/// Withdrawal request entry. The minimum (Le5) and available-balance
/// checks are enforced server-side — this screen's own validation is a
/// UX convenience only. A submitted withdrawal holds the funds
/// immediately but requires admin approval before any payout is sent;
/// the success message reflects that, not a completed payout.
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
  String? _errorMessage;
  String? _successMessage;

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
      _successMessage = null;
    });

    try {
      final amountLeones = double.parse(_amountController.text.trim());
      final amountMinor = (amountLeones * 100).round().toString();

      await widget.walletController.withdraw(
        amountMinor: amountMinor,
        destinationDetails: {
          'method': 'ORANGE_MONEY',
          'phoneNumber': _phoneController.text.trim(),
        },
      );

      setState(() {
        _successMessage =
            'Withdrawal requested. The amount is now held and will be '
            'reviewed by PlayLe before payout.';
        _amountController.clear();
        _phoneController.clear();
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
      appBar: AppBar(title: const Text('Withdraw')),
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
                  validator: (value) => (value == null || value.trim().isEmpty)
                      ? 'Required'
                      : null,
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
                      : const Text('Request withdrawal'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
