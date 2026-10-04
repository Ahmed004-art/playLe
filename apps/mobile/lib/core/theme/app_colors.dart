import 'package:flutter/material.dart';

/// Design-token color palette. Placeholder values for Phase 1 — final
/// premium-gaming visual identity is designed in a later UI phase (see
/// docs/architecture/OVERVIEW.md). Keeping colors centralized here means
/// that later restyling touches this file, not every screen.
abstract final class AppColors {
  static const Color primary = Color(0xFF6C4CF1);
  static const Color secondary = Color(0xFF00D9C0);
  static const Color background = Color(0xFF0E0E14);
  static const Color surface = Color(0xFF17171F);
  static const Color error = Color(0xFFFF4D67);
  static const Color onPrimary = Color(0xFFFFFFFF);
  static const Color onBackground = Color(0xFFF2F2F7);
  static const Color onSurfaceMuted = Color(0xFF9494A6);
}
