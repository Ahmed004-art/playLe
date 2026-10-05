import 'package:flutter/material.dart';

import 'core/auth/auth_controller.dart';
import 'core/di/service_locator.dart';
import 'core/routing/app_router.dart';
import 'core/theme/app_theme.dart';
import 'core/wallet/wallet_controller.dart';

class PlayLeApp extends StatelessWidget {
  const PlayLeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'PlayLe',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.dark,
      darkTheme: AppTheme.dark,
      themeMode: ThemeMode.dark,
      routerConfig: buildAppRouter(
        sl<AuthController>(),
        sl<WalletController>(),
      ),
    );
  }
}
