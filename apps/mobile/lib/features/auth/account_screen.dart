import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/auth/auth_state.dart';
import '../../core/theme/app_colors.dart';

/// The authenticated landing screen. Intentionally minimal — just proves
/// the session is live and gives a way to log out. Game/social/wallet UI
/// belong to later phases.
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
            child: Padding(
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
                  const SizedBox(height: 24),
                  FilledButton(
                    onPressed: () => context.push('/wallet'),
                    child: const Text('Wallet'),
                  ),
                  const Spacer(),
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
