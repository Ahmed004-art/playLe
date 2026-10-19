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

  // Game-board tokens (Phase 7) — shared across every board game, not
  // Checkers-specific, so a future game reuses the same visual language
  // rather than inventing its own. Deliberately restrained: pieces reuse
  // `primary`/`secondary` (the same "player 1 / player 2" convention
  // Tic-Tac-Toe's X/O already established) rather than new per-game
  // colors, and interaction states (selected, legal move, illegal move)
  // reuse `secondary`/`error` at different opacities rather than adding
  // near-duplicate tokens.
  static const Color boardLight = Color(0xFF232330);
  static const Color boardDark = Color(0xFF14141C);
  static const Color pieceP1 = primary;
  static const Color pieceP2 = secondary;
  static const Color kingAccent = Color(0xFFFFC857);

  // Dice tokens (Phase 10) — an ivory die face with deep-violet pips, so
  // dice read as physical objects against the dark surface while staying
  // inside the existing violet/teal palette (no new brand colors).
  static const Color diceFaceLight = Color(0xFFFAF8FF);
  static const Color diceFaceShade = Color(0xFFD9D3F2);
  static const Color dicePip = Color(0xFF1B1530);
}
