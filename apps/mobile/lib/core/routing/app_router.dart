import 'package:go_router/go_router.dart';

import '../../features/foundation/foundation_screen.dart';

/// Routing/navigation foundation. Phase 1 defines a single route (the
/// foundation/dev screen). Feature routes are added under their own
/// `/features/<feature>` route group as each feature is implemented.
final GoRouter appRouter = GoRouter(
  initialLocation: '/',
  routes: [
    GoRoute(path: '/', builder: (context, state) => const FoundationScreen()),
  ],
);
