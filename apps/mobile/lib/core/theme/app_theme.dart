import 'package:flutter/material.dart';

import 'app_colors.dart';

/// Theme foundation. Establishes the design-system scaffolding (color
/// scheme, typography scale, component defaults) so later UI-polish phases
/// restyle this file rather than restructuring the app. Defaults to a dark,
/// premium-leaning surface per the product's intended visual direction
/// (see docs/architecture/OVERVIEW.md).
abstract final class AppTheme {
  static ThemeData get dark {
    final colorScheme = ColorScheme.fromSeed(
      seedColor: AppColors.primary,
      brightness: Brightness.dark,
      primary: AppColors.primary,
      secondary: AppColors.secondary,
      surface: AppColors.surface,
      error: AppColors.error,
    );

    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: AppColors.background,
      textTheme: _textTheme,
      appBarTheme: const AppBarTheme(
        backgroundColor: AppColors.background,
        foregroundColor: AppColors.onBackground,
        elevation: 0,
      ),
      cardTheme: CardThemeData(
        color: AppColors.surface,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.primary,
          foregroundColor: AppColors.onPrimary,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
        ),
      ),
    );
  }

  static const TextTheme _textTheme = TextTheme(
    headlineMedium: TextStyle(
      fontWeight: FontWeight.w700,
      color: AppColors.onBackground,
    ),
    titleMedium: TextStyle(
      fontWeight: FontWeight.w600,
      color: AppColors.onBackground,
    ),
    bodyMedium: TextStyle(color: AppColors.onBackground),
    bodySmall: TextStyle(color: AppColors.onSurfaceMuted),
  );
}
