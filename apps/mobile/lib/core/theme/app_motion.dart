import 'package:flutter/animation.dart';

/// Animation durations/curves (Phase 7). Before this, the only animation
/// anywhere in the app was Tic-Tac-Toe's mark scale-in, with its duration
/// and curve inlined at the call site. Centralized here so every new
/// animation (piece movement, capture, king promotion, selection) is
/// consistent and so "reduced motion" can later be implemented by
/// swapping these in one place rather than hunting down every
/// `TweenAnimationBuilder`.
abstract final class AppMotion {
  /// A small state change (e.g. a mark/piece appearing, a highlight
  /// toggling).
  static const Duration fast = Duration(milliseconds: 160);

  /// A piece sliding from one square to another, a banner appearing.
  static const Duration normal = Duration(milliseconds: 220);

  /// A multi-step sequence (e.g. a capture then a king-promotion glow).
  static const Duration slow = Duration(milliseconds: 320);

  static const Curve entrance = Curves.easeOutBack;
  static const Curve standard = Curves.easeOutCubic;
}
