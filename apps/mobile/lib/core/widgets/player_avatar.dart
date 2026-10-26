import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// A round avatar showing a player's initials. The API has no avatar image
/// for players (and this app must not invent one), so initials are the real
/// representation, not a placeholder: "Ada Lovelace" is "AL", "playerone" is
/// "P". Decorative - the player's name is always shown beside it - so it is
/// excluded from the semantics tree.
class PlayerAvatar extends StatelessWidget {
  const PlayerAvatar({super.key, required this.name, this.radius = 24});

  final String name;
  final double radius;

  /// "Ada Lovelace" -> "AL", "playerone" -> "P", blank -> "?".
  static String initialsFor(String name) {
    final words = name
        .trim()
        .split(RegExp(r'\s+'))
        .where((w) => w.isNotEmpty)
        .toList();
    if (words.isEmpty) {
      return '?';
    }
    String first(String word) =>
        String.fromCharCode(word.runes.first).toUpperCase();
    if (words.length == 1) {
      return first(words.first);
    }
    return '${first(words.first)}${first(words.last)}';
  }

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: CircleAvatar(
        radius: radius,
        backgroundColor: AppColors.primary.withValues(alpha: 0.25),
        child: Text(
          initialsFor(name),
          style: TextStyle(
            fontSize: radius * 0.8,
            fontWeight: FontWeight.bold,
            color: AppColors.onBackground,
          ),
        ),
      ),
    );
  }
}
