/// Spacing scale (Phase 7). Centralizes the `SizedBox`/`EdgeInsets` values
/// that were previously hardcoded per-widget (4, 6, 8, 10, 12, 16, 20, 24,
/// 32 all appeared ad hoc across screens) so new screens pick from a fixed
/// scale instead of inventing another one-off number.
abstract final class AppSpacing {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;
}
