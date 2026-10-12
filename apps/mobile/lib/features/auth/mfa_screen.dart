import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../core/errors/app_exception.dart';
import '../../core/mfa/mfa_controller.dart';
import '../../core/mfa/mfa_models.dart';
import '../../core/mfa/mfa_state.dart';
import '../../core/theme/app_colors.dart';

/// Two-factor authentication (TOTP) enrollment, confirmation, and
/// disablement — mirrors `apps/api/src/mfa/mfa.controller.ts`. The
/// *login-time* challenge screen lives separately at
/// `mfa_challenge_screen.dart`, since it's part of the login flow, not
/// account management.
class MfaScreen extends StatefulWidget {
  const MfaScreen({super.key, required this.mfaController});

  final MfaController mfaController;

  @override
  State<MfaScreen> createState() => _MfaScreenState();
}

class _MfaScreenState extends State<MfaScreen> {
  @override
  void initState() {
    super.initState();
    widget.mfaController.refresh();
  }

  Future<void> _startEnrollment() async {
    MfaEnrollment enrollment;
    try {
      enrollment = await widget.mfaController.enroll();
    } on AppException catch (e) {
      _showError(e.message);
      return;
    }
    if (!mounted) return;

    final ready = await showDialog<bool>(
      context: context,
      builder: (context) => _EnrollmentSetupDialog(enrollment: enrollment),
    );
    if (ready != true || !mounted) return;

    final code = await showDialog<String>(
      context: context,
      builder: (context) => const _CodeEntryDialog(
        title: 'Confirm setup',
        helperText: 'Enter the 6-digit code from your authenticator app.',
        confirmLabel: 'Enable',
      ),
    );
    if (code == null || code.isEmpty || !mounted) return;

    try {
      final recoveryCodes = await widget.mfaController.confirm(code);
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (context) => _RecoveryCodesDialog(codes: recoveryCodes),
      );
    } on AppException catch (e) {
      _showError(e.message);
    }
  }

  Future<void> _disable() async {
    final code = await showDialog<String>(
      context: context,
      builder: (context) => const _CodeEntryDialog(
        title: 'Disable two-factor authentication',
        helperText:
            'Enter your current 6-digit code to confirm you still control '
            'this account.',
        confirmLabel: 'Disable',
      ),
    );
    if (code == null || code.isEmpty || !mounted) return;

    try {
      await widget.mfaController.disable(code);
    } on AppException catch (e) {
      _showError(e.message);
    }
  }

  void _showError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Two-factor authentication')),
      body: ListenableBuilder(
        listenable: widget.mfaController,
        builder: (context, _) {
          final state = widget.mfaController.state;
          return switch (state) {
            MfaLoading() => const Center(child: CircularProgressIndicator()),
            MfaLoadError(message: final message) => Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(message, textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    OutlinedButton(
                      onPressed: widget.mfaController.refresh,
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            ),
            MfaLoaded(enabled: final enabled) => SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Icon(
                      enabled ? Icons.verified_user : Icons.shield_outlined,
                      size: 48,
                      color: enabled
                          ? AppColors.secondary
                          : AppColors.onSurfaceMuted,
                    ),
                    const SizedBox(height: 16),
                    Text(
                      enabled
                          ? 'Two-factor authentication is on'
                          : 'Two-factor authentication is off',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      enabled
                          ? "You'll be asked for a 6-digit code (or a "
                                "recovery code) every time you log in."
                          : 'Add an extra layer of security: once enabled, '
                                "you'll need a code from an authenticator "
                                'app to log in.',
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: AppColors.onSurfaceMuted,
                      ),
                    ),
                    const SizedBox(height: 24),
                    if (enabled)
                      OutlinedButton(
                        onPressed: _disable,
                        child: const Text('Disable two-factor authentication'),
                      )
                    else
                      FilledButton(
                        onPressed: _startEnrollment,
                        child: const Text('Enable two-factor authentication'),
                      ),
                  ],
                ),
              ),
            ),
          };
        },
      ),
    );
  }
}

class _EnrollmentSetupDialog extends StatelessWidget {
  const _EnrollmentSetupDialog({required this.enrollment});

  final MfaEnrollment enrollment;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Scan with your authenticator app'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                padding: const EdgeInsets.all(12),
                color: Colors.white,
                child: QrImageView(
                  data: enrollment.otpauthUri,
                  size: 200,
                  backgroundColor: Colors.white,
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text(
              "Can't scan? Enter this code manually:",
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: SelectableText(
                    enrollment.secret,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.copy, size: 18),
                  tooltip: 'Copy',
                  onPressed: () =>
                      Clipboard.setData(ClipboardData(text: enrollment.secret)),
                ),
              ],
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
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text("I've added it"),
        ),
      ],
    );
  }
}

class _CodeEntryDialog extends StatefulWidget {
  const _CodeEntryDialog({
    required this.title,
    required this.helperText,
    required this.confirmLabel,
  });

  final String title;
  final String helperText;
  final String confirmLabel;

  @override
  State<_CodeEntryDialog> createState() => _CodeEntryDialogState();
}

class _CodeEntryDialogState extends State<_CodeEntryDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(widget.helperText),
          const SizedBox(height: 16),
          TextField(
            controller: _controller,
            autofocus: true,
            maxLength: 32,
            decoration: const InputDecoration(labelText: 'Code'),
            onSubmitted: (_) =>
                Navigator.of(context).pop(_controller.text.trim()),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_controller.text.trim()),
          child: Text(widget.confirmLabel),
        ),
      ],
    );
  }
}

/// Shows single-use recovery codes exactly once, with a required
/// acknowledgment before the dialog can be dismissed — they are never
/// shown again after this.
class _RecoveryCodesDialog extends StatefulWidget {
  const _RecoveryCodesDialog({required this.codes});

  final List<String> codes;

  @override
  State<_RecoveryCodesDialog> createState() => _RecoveryCodesDialogState();
}

class _RecoveryCodesDialogState extends State<_RecoveryCodesDialog> {
  bool _acknowledged = false;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Save your recovery codes'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Two-factor authentication is now enabled. Store these '
              'single-use recovery codes somewhere safe — each can be '
              "used once to log in if you lose access to your "
              'authenticator app. They will not be shown again.',
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.surface,
                borderRadius: BorderRadius.circular(8),
              ),
              child: SelectableText(
                widget.codes.join('\n'),
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
            const SizedBox(height: 16),
            CheckboxListTile(
              value: _acknowledged,
              onChanged: (value) =>
                  setState(() => _acknowledged = value ?? false),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: const Text("I've saved these recovery codes"),
            ),
          ],
        ),
      ),
      actions: [
        FilledButton(
          onPressed: _acknowledged ? () => Navigator.of(context).pop() : null,
          child: const Text('Done'),
        ),
      ],
    );
  }
}
