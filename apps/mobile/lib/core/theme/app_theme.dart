import 'package:flutter/material.dart';

import 'app_colors.dart';
import 'app_radii.dart';

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
      // `FilledButton`/`OutlinedButton` are what every screen actually
      // uses (an `ElevatedButton` theme was defined here but never
      // referenced anywhere) — themed explicitly so shape/padding stay
      // on the same scale as the rest of the design system rather than
      // falling back to Material 3's untouched defaults.
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AppColors.primary,
          foregroundColor: AppColors.onPrimary,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadii.sm),
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.onBackground,
          side: const BorderSide(color: AppColors.onSurfaceMuted),
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadii.sm),
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
    headlineSmall: TextStyle(
      fontWeight: FontWeight.w700,
      color: AppColors.onBackground,
    ),
    titleMedium: TextStyle(
      fontWeight: FontWeight.w600,
      color: AppColors.onBackground,
    ),
    titleSmall: TextStyle(
      fontWeight: FontWeight.w600,
      color: AppColors.onBackground,
    ),
    bodyMedium: TextStyle(color: AppColors.onBackground),
    bodySmall: TextStyle(color: AppColors.onSurfaceMuted),
    labelSmall: TextStyle(
      fontWeight: FontWeight.w600,
      color: AppColors.onSurfaceMuted,
    ),
  );
}
