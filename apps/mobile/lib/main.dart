import 'package:flutter/material.dart';

import 'app.dart';
import 'core/auth/auth_controller.dart';
import 'core/auth/auth_state.dart';
import 'core/di/service_locator.dart';
import 'core/realtime/realtime_connection_manager.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await setupServiceLocator();

  final authController = sl<AuthController>();
  final realtime = sl<RealtimeConnectionManager>();

  // Keep the realtime connection's lifetime tied to having a session at
  // all — `AuthController` itself stays free of any realtime-specific
  // dependency (see core/realtime/realtime_connection_manager.dart).
  authController.addListener(() {
    switch (authController.state) {
      case AuthAuthenticated():
        realtime.connect();
      case AuthUnauthenticated():
        realtime.disconnect();
      case AuthUnknown():
        break;
    }
  });

  await authController.bootstrap();
  runApp(const PlayLeApp());
}
