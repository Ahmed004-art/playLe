import 'package:flutter/material.dart';

import '../theme/app_spacing.dart';

/// Shown when the API answers 401: the session is no longer valid. The only
/// action is to sign in again, which the caller wires to the existing
/// `AuthController.logout()` (the router then returns to the welcome screen).
class SessionExpiredView extends StatelessWidget {
  const SessionExpiredView({super.key, required this.onSignIn});

  final VoidCallback onSignIn;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Your session has expired. Please sign in again.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: AppSpacing.lg),
            OutlinedButton(
              onPressed: onSignIn,
              child: const Text('Sign in again'),
            ),
          ],
        ),
      ),
    );
  }
}
