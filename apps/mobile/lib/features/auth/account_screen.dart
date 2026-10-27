import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/auth/auth_state.dart';
import '../../core/theme/app_colors.dart';
import 'verification_dialog.dart';

/// The authenticated landing screen — a minimal hub linking out to
/// Games, Wallet, the player's own profile and match history (Phase 12).
/// Friends and blocking screens arrive in a later Phase 12 PR.
///
/// Takes [authController] explicitly (rather than pulling it from the
/// global service locator itself) so it always renders the same
/// controller instance driving the router's redirect logic — this is what
/// makes it possible to test routing and this screen together with a fake
/// controller, with no GetIt registration required.
class AccountScreen extends StatelessWidget {
  const AccountScreen({super.key, required this.authController});

  final AuthController authController;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('PlayLe')),
      body: ListenableBuilder(
        listenable: authController,
        builder: (context, _) {
          final state = authController.state;
          if (state is! AuthAuthenticated) {
            return const SizedBox.shrink();
          }
          final user = state.user;

          return SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  CircleAvatar(
                    radius: 36,
                    backgroundColor: AppColors.surface,
                    child: Text(
                      user.username.isNotEmpty
                          ? user.username[0].toUpperCase()
                          : '?',
                      style: const TextStyle(
                        fontSize: 28,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    user.displayName?.isNotEmpty == true
                        ? user.displayName!
                        : user.username,
                    style: Theme.of(context).textTheme.headlineMedium,
                  ),
                  Text(
                    '@${user.username}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  const SizedBox(height: 24),
                  _InfoRow(label: 'Email', value: user.email),
                  if (user.phoneNumber != null)
                    _InfoRow(label: 'Phone', value: user.phoneNumber!),
                  _InfoRow(label: 'Role', value: user.role),
                  _InfoRow(label: 'Status', value: user.status),
                  const SizedBox(height: 8),
                  _VerificationRow(
                    label: 'Email',
                    verified: user.isEmailVerified,
                    onVerify: () => showVerificationDialog(
                      context,
                      authController: authController,
                      channel: 'EMAIL',
                    ),
                  ),
                  if (user.phoneNumber != null)
                    _VerificationRow(
                      label: 'Phone',
                      verified: user.isPhoneVerified,
                      onVerify: () => showVerificationDialog(
                        context,
                        authController: authController,
                        channel: 'SMS',
                      ),
                    ),
                  const SizedBox(height: 24),
                  FilledButton(
                    onPressed: () => context.push('/games'),
                    child: const Text('Games'),
                  ),
                  const SizedBox(height: 12),
                  FilledButton(
                    onPressed: () => context.push('/wallet'),
                    child: const Text('Wallet'),
                  ),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: () => context.push('/players/${user.id}'),
                    child: const Text('My profile'),
                  ),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: () => context.push('/history'),
                    child: const Text('Match history'),
                  ),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: () => context.push('/disputes'),
                    child: const Text('My Disputes'),
                  ),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: () => context.push('/account/mfa'),
                    child: const Text('Two-factor authentication'),
                  ),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: () => context.push('/account/sessions'),
                    child: const Text('Active sessions'),
                  ),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: () =>
                        context.push('/account/responsible-gaming'),
                    child: const Text('Responsible gaming'),
                  ),
                  const SizedBox(height: 24),
                  OutlinedButton(
                    onPressed: () => authController.logout(),
                    child: const Text('Log out'),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class _VerificationRow extends StatelessWidget {
  const _VerificationRow({
    required this.label,
    required this.verified,
    required this.onVerify,
  });

  final String label;
  final bool verified;
  final VoidCallback onVerify;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Expanded(
            child: Text(
              verified ? '$label: verified' : '$label: not verified',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: verified
                    ? AppColors.secondary
                    : AppColors.onSurfaceMuted,
              ),
            ),
          ),
          if (!verified)
            TextButton(onPressed: onVerify, child: const Text('Verify now')),
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Text(
        '$label: $value',
        style: Theme.of(context).textTheme.bodyMedium,
      ),
    );
  }
}
