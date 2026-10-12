import 'package:flutter/material.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/errors/app_exception.dart';

/// Requests and confirms an email/phone verification code
/// (`POST /auth/verification/request|confirm` — channel is `'EMAIL'` or
/// `'SMS'`). Shown as a dialog from `account_screen.dart`'s verification
/// status row. Sends the request as soon as the dialog opens so the
/// user doesn't need an extra tap to get the code sent.
Future<void> showVerificationDialog(
  BuildContext context, {
  required AuthController authController,
  required String channel,
}) {
  return showDialog<void>(
    context: context,
    builder: (context) =>
        _VerificationDialog(authController: authController, channel: channel),
  );
}

class _VerificationDialog extends StatefulWidget {
  const _VerificationDialog({
    required this.authController,
    required this.channel,
  });

  final AuthController authController;
  final String channel;

  @override
  State<_VerificationDialog> createState() => _VerificationDialogState();
}

class _VerificationDialogState extends State<_VerificationDialog> {
  final _codeController = TextEditingController();

  bool _sending = true;
  bool _confirming = false;
  String? _errorMessage;
  bool _confirmed = false;

  @override
  void initState() {
    super.initState();
    _requestCode();
  }

  @override
  void dispose() {
    _codeController.dispose();
    super.dispose();
  }

  Future<void> _requestCode() async {
    setState(() {
      _sending = true;
      _errorMessage = null;
    });
    try {
      await widget.authController.requestVerification(widget.channel);
    } on AppException catch (e) {
      if (mounted) setState(() => _errorMessage = e.message);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _confirm() async {
    setState(() {
      _confirming = true;
      _errorMessage = null;
    });
    try {
      await widget.authController.confirmVerification(
        channel: widget.channel,
        code: _codeController.text.trim(),
      );
      if (mounted) setState(() => _confirmed = true);
    } on AppException catch (e) {
      if (mounted) setState(() => _errorMessage = e.message);
    } finally {
      if (mounted) setState(() => _confirming = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final channelLabel = widget.channel == 'EMAIL' ? 'email' : 'phone';

    if (_confirmed) {
      return AlertDialog(
        title: const Text('Verified'),
        content: Text('Your $channelLabel has been verified.'),
        actions: [
          FilledButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Done'),
          ),
        ],
      );
    }

    return AlertDialog(
      title: Text('Verify your $channelLabel'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_sending)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Row(
                children: [
                  SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  SizedBox(width: 12),
                  Text('Sending code…'),
                ],
              ),
            )
          else ...[
            Text('Enter the code we sent to your $channelLabel.'),
            const SizedBox(height: 12),
            TextField(
              controller: _codeController,
              autofocus: true,
              maxLength: 16,
              decoration: const InputDecoration(labelText: 'Code'),
            ),
          ],
          if (_errorMessage != null) ...[
            const SizedBox(height: 8),
            Text(
              _errorMessage!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: (_sending || _confirming) ? null : _confirm,
          child: _confirming
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Verify'),
        ),
      ],
    );
  }
}
