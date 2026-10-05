import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/games/games_controller.dart';
import '../../core/theme/app_colors.dart';

/// The game catalog — currently just Tic-Tac-Toe, but the layout (a grid
/// of game cards) doesn't assume there's only one. Future games appear
/// here automatically once registered server-side (see
/// docs/decisions/ADR-015-game-module-architecture.md) — no client
/// change needed to list a new one.
class GamesCatalogScreen extends StatefulWidget {
  const GamesCatalogScreen({super.key, required this.gamesController});

  final GamesController gamesController;

  @override
  State<GamesCatalogScreen> createState() => _GamesCatalogScreenState();
}

class _GamesCatalogScreenState extends State<GamesCatalogScreen> {
  @override
  void initState() {
    super.initState();
    widget.gamesController.refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Games')),
      body: ListenableBuilder(
        listenable: widget.gamesController,
        builder: (context, _) {
          final state = widget.gamesController.state;

          return switch (state) {
            GamesLoading() => const Center(child: CircularProgressIndicator()),
            GamesLoadError(message: final message) => Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(message, textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    OutlinedButton(
                      onPressed: widget.gamesController.refresh,
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            ),
            GamesLoaded(games: final games) =>
              games.isEmpty
                  ? const Center(child: Text('No games available right now.'))
                  : RefreshIndicator(
                      onRefresh: widget.gamesController.refresh,
                      child: GridView.builder(
                        padding: const EdgeInsets.all(20),
                        gridDelegate:
                            const SliverGridDelegateWithFixedCrossAxisCount(
                              crossAxisCount: 2,
                              mainAxisSpacing: 16,
                              crossAxisSpacing: 16,
                              childAspectRatio: 0.85,
                            ),
                        itemCount: games.length,
                        itemBuilder: (context, index) {
                          final game = games[index];
                          return _GameCard(
                            displayName: game.displayName,
                            description: game.description,
                            onTap: () => context.push(
                              '/games/${game.id}?name=${Uri.encodeQueryComponent(game.displayName)}',
                            ),
                          );
                        },
                      ),
                    ),
          };
        },
      ),
    );
  }
}

class _GameCard extends StatelessWidget {
  const _GameCard({
    required this.displayName,
    required this.description,
    required this.onTap,
  });

  final String displayName;
  final String description;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(20),
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [AppColors.primary, AppColors.secondary],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  borderRadius: BorderRadius.circular(14),
                ),
                child: const Icon(Icons.grid_3x3_rounded, color: Colors.white),
              ),
              const SizedBox(height: 16),
              Text(displayName, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 4),
              Text(
                description,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: AppColors.onSurfaceMuted,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
