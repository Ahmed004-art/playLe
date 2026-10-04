import 'package:flutter/material.dart';

import '../../core/config/app_config.dart';
import '../../core/di/service_locator.dart';

/// Phase 1 development/foundation screen.
///
/// This intentionally is NOT the final PlayLe UI — it exists only to prove
/// the app boots, the theme/routing/DI foundation works, and the API base
/// URL is configured correctly. Game, wallet, social, and matchmaking
/// screens are built in later phases.
class FoundationScreen extends StatelessWidget {
  const FoundationScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final config = sl<AppConfig>();

    return Scaffold(
      appBar: AppBar(title: const Text('PlayLe — Foundation')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'PlayLe',
                    style: Theme.of(context).textTheme.headlineMedium,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Phase 1 — Foundation build',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 16),
                  _InfoRow(
                    label: 'Environment',
                    value: config.environment.name,
                  ),
                  _InfoRow(label: 'API base URL', value: config.apiBaseUrl),
                  _InfoRow(label: 'Socket URL', value: config.socketUrl),
                ],
              ),
            ),
          ),
        ),
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
        style: Theme.of(context).textTheme.bodySmall,
      ),
    );
  }
}
