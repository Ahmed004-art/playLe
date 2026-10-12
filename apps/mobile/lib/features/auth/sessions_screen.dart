import 'package:flutter/material.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/errors/app_exception.dart';
import '../../core/sessions/session_models.dart';
import '../../core/sessions/sessions_controller.dart';
import '../../core/sessions/sessions_state.dart';
import '../../core/theme/app_colors.dart';

/// "Active sessions" / "Manage devices" — lists every active login for
/// this account (`GET /auth/sessions`) with a per-row "Sign out" and a
/// "Sign out everywhere" action. Mirrors
/// `core/disputes/disputes_controller.dart`'s list-screen shape.
class SessionsScreen extends StatefulWidget {
  const SessionsScreen({
    super.key,
    required this.sessionsController,
    required this.authController,
  });

  final SessionsController sessionsController;
  final AuthController authController;

  @override
  State<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends State<SessionsScreen> {
  bool _revokingAll = false;

  @override
  void initState() {
    super.initState();
    widget.sessionsController.refresh();
  }

  Future<void> _revoke(String id) async {
    try {
      await widget.sessionsController.revoke(id);
    } on AppException catch (e) {
      _showError(e.message);
    }
  }

  Future<void> _revokeAll() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Sign out everywhere?'),
        content: const Text(
          'This ends every active session for your account, including '
          'this device. You will need to log in again.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Sign out everywhere'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() => _revokingAll = true);
    try {
      await widget.sessionsController.revokeAll();
      // The server already ended this device's session as part of that
      // call — run the exact same local logout flow as a normal logout
      // so secure storage/realtime state is cleared consistently.
      await widget.authController.logout();
    } on AppException catch (e) {
      if (mounted) {
        setState(() => _revokingAll = false);
        _showError(e.message);
      }
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
      appBar: AppBar(title: const Text('Active sessions')),
      body: ListenableBuilder(
        listenable: widget.sessionsController,
        builder: (context, _) {
          final state = widget.sessionsController.state;
          return switch (state) {
            SessionsLoading() => const Center(
              child: CircularProgressIndicator(),
            ),
            SessionsLoadError(message: final message) => Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(message, textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    OutlinedButton(
                      onPressed: widget.sessionsController.refresh,
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            ),
            SessionsLoaded(sessions: final sessions) => RefreshIndicator(
              onRefresh: widget.sessionsController.refresh,
              child: ListView(
                padding: const EdgeInsets.all(24),
                children: [
                  for (final session in sessions)
                    _SessionRow(
                      session: session,
                      onRevoke: () => _revoke(session.id),
                    ),
                  if (sessions.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      child: Text(
                        'No active sessions.',
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: AppColors.onSurfaceMuted,
                        ),
                      ),
                    ),
                  const SizedBox(height: 24),
                  OutlinedButton(
                    onPressed: _revokingAll ? null : _revokeAll,
                    child: _revokingAll
                        ? const SizedBox(
                            height: 18,
                            width: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Sign out everywhere'),
                  ),
                ],
              ),
            ),
          };
        },
      ),
    );
  }
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({required this.session, required this.onRevoke});

  final SessionInfo session;
  final VoidCallback onRevoke;

  @override
  Widget build(BuildContext context) {
    final userAgent = session.userAgent ?? 'Unknown device';
    final ipAddress = session.ipAddress;

    return Card(
      color: AppColors.surface,
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    userAgent,
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    [
                      ?ipAddress,
                      'Created ${_formatDate(session.createdAt)}',
                    ].join(' · '),
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: AppColors.onSurfaceMuted,
                    ),
                  ),
                ],
              ),
            ),
            TextButton(onPressed: onRevoke, child: const Text('Sign out')),
          ],
        ),
      ),
    );
  }

  String _formatDate(DateTime date) =>
      date.toLocal().toString().split('.').first;
}
