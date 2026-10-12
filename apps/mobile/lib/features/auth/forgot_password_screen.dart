import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/errors/app_exception.dart';
import '../../core/theme/app_colors.dart';

/// Password reset: request a code → confirm it with a new password →
/// back to login. `/auth/password-reset/request` always returns the
/// same generic message whether or not the identifier matches an
/// account (anti-enumeration — see
/// docs/decisions/ADR-020-account-security.md) — this screen displays
/// that message verbatim, never a message it composes itself, so it can
/// never leak whether an account exists. A successful reset revokes
/// every session server-side, so this screen sends the user back to
/// `/login` rather than attempting to auto-login.
class ForgotPasswordScreen extends StatefulWidget {
  const ForgotPasswordScreen({super.key, required this.authController});

  final AuthController authController;

  @override
  State<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

enum _Step { identifier, confirm, done }

class _ForgotPasswordScreenState extends State<ForgotPasswordScreen> {
  final _identifierFormKey = GlobalKey<FormState>();
  final _confirmFormKey = GlobalKey<FormState>();
  final _identifierController = TextEditingController();
  final _codeController = TextEditingController();
  final _newPasswordController = TextEditingController();

  _Step _step = _Step.identifier;
  bool _submitting = false;
  String? _errorMessage;
  String? _requestMessage;

  @override
  void dispose() {
    _identifierController.dispose();
    _codeController.dispose();
    _newPasswordController.dispose();
    super.dispose();
  }

  Future<void> _submitIdentifier() async {
    if (!_identifierFormKey.currentState!.validate()) return;

    setState(() {
      _submitting = true;
      _errorMessage = null;
    });

    try {
      final message = await widget.authController.requestPasswordReset(
        _identifierController.text.trim(),
      );
      setState(() {
        _requestMessage = message;
        _step = _Step.confirm;
      });
    } on AppException catch (e) {
      setState(() => _errorMessage = e.message);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _submitConfirm() async {
    if (!_confirmFormKey.currentState!.validate()) return;

    setState(() {
      _submitting = true;
      _errorMessage = null;
    });

    try {
      await widget.authController.confirmPasswordReset(
        token: _codeController.text.trim(),
        newPassword: _newPasswordController.text,
      );
      setState(() => _step = _Step.done);
    } on AppException catch (e) {
      setState(() => _errorMessage = e.message);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Reset password')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: switch (_step) {
            _Step.identifier => _buildIdentifierStep(context),
            _Step.confirm => _buildConfirmStep(context),
            _Step.done => _buildDoneStep(context),
          },
        ),
      ),
    );
  }

  Widget _buildIdentifierStep(BuildContext context) {
    return Form(
      key: _identifierFormKey,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Enter the email or phone number on your account and we will '
            'send you a reset code.',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 16),
          TextFormField(
            controller: _identifierController,
            decoration: const InputDecoration(
              labelText: 'Email or phone number',
            ),
            validator: (value) =>
                (value == null || value.trim().isEmpty) ? 'Required' : null,
          ),
          if (_errorMessage != null) ...[
            const SizedBox(height: 16),
            Text(
              _errorMessage!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ],
          const SizedBox(height: 24),
          FilledButton(
            onPressed: _submitting ? null : _submitIdentifier,
            child: _submitting
                ? const SizedBox(
                    height: 18,
                    width: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Send reset code'),
          ),
        ],
      ),
    );
  }

  Widget _buildConfirmStep(BuildContext context) {
    return Form(
      key: _confirmFormKey,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_requestMessage != null)
            Text(
              _requestMessage!,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: AppColors.secondary),
            ),
          const SizedBox(height: 16),
          TextFormField(
            controller: _codeController,
            decoration: const InputDecoration(labelText: 'Reset code'),
            validator: (value) =>
                (value == null || value.trim().isEmpty) ? 'Required' : null,
          ),
          const SizedBox(height: 16),
          TextFormField(
            controller: _newPasswordController,
            decoration: const InputDecoration(labelText: 'New password'),
            obscureText: true,
            validator: (value) {
              if (value == null || value.length < 8) {
                return 'At least 8 characters';
              }
              if (!RegExp(r'^(?=.*[A-Za-z])(?=.*\d).+$').hasMatch(value)) {
                return 'Must contain a letter and a number';
              }
              return null;
            },
          ),
          if (_errorMessage != null) ...[
            const SizedBox(height: 16),
            Text(
              _errorMessage!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ],
          const SizedBox(height: 24),
          FilledButton(
            onPressed: _submitting ? null : _submitConfirm,
            child: _submitting
                ? const SizedBox(
                    height: 18,
                    width: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Reset password'),
          ),
        ],
      ),
    );
  }

  Widget _buildDoneStep(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(
          Icons.check_circle_outline,
          size: 48,
          color: AppColors.secondary,
        ),
        const SizedBox(height: 16),
        Text(
          'Your password has been reset. For your security, you have '
          'been signed out everywhere and will need to log in again.',
          style: Theme.of(context).textTheme.bodyMedium,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 24),
        FilledButton(
          onPressed: () => context.go('/login'),
          child: const Text('Back to login'),
        ),
      ],
    );
  }
}
