import 'package:flutter/material.dart';

import 'app.dart';
import 'core/auth/auth_controller.dart';
import 'core/di/service_locator.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await setupServiceLocator();
  await sl<AuthController>().bootstrap();
  runApp(const PlayLeApp());
}
