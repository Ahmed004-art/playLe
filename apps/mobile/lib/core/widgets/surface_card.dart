import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_radii.dart';
import '../theme/app_spacing.dart';

/// A rounded, `AppColors.surface`-filled container — the "surface
/// container" pattern (`Container` + `BoxDecoration(color: surface,
/// borderRadius: ...)`) repeated at least five times across wallet,
/// match-result and stake screens before this (Phase 7).
class SurfaceCard extends StatelessWidget {
  const SurfaceCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AppSpacing.xl),
    this.borderRadius = AppRadii.lg,
    this.border,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double borderRadius;
  final Color? border;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(borderRadius),
        border: border != null ? Border.all(color: border!) : null,
      ),
      child: child,
    );
  }
}
