import 'package:flutter/material.dart';

/// A centered spinner — the loading state repeated verbatim across
/// `MatchScreen`, `GamesCatalogScreen` and `GameLobbyScreen` before this
/// (Phase 7). Not wrapped in a `Scaffold` itself so callers can place it
/// inside their own `Scaffold`/`body` as needed.
class LoadingView extends StatelessWidget {
  const LoadingView({super.key});

  @override
  Widget build(BuildContext context) {
    return const Center(child: CircularProgressIndicator());
  }
}
