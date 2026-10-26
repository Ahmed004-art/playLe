import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/auth/auth_state.dart';
import '../../core/games/games_repository.dart';
import '../../core/social/match_history_controller.dart';
import '../../core/social/match_history_state.dart';
import '../../core/social/social_models.dart';
import '../../core/social/social_repository.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_radii.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/widgets/empty_state_view.dart';
import '../../core/widgets/error_retry_view.dart';
import '../../core/widgets/loading_view.dart';

/// The signed-in player's own match history, newest first, built from what
/// the API already provides (`GET /matches`, cursor-paged). Each row shows the
/// game, the opponent, how the match ended and when - and nothing about money:
/// the match contract carries no stake or transaction data, so none can be
/// shown.
///
/// Results follow the stored result only: a win, loss or draw is shown only
/// for a completed match whose stored outcome says so; an abandoned match is
/// shown as abandoned, a cancelled one as cancelled, one still going as in
/// progress. See `describeMatchResult`.
///
/// Opponent names come from one batch request per page (never one per row).
/// Tapping a row opens the opponent's profile when the match had exactly one
/// opponent.
class MatchHistoryScreen extends StatefulWidget {
  const MatchHistoryScreen({
    super.key,
    required this.repository,
    required this.gamesRepository,
    required this.authController,
  });

  final SocialRepository repository;
  final GamesRepository gamesRepository;
  final AuthController authController;

  @override
  State<MatchHistoryScreen> createState() => _MatchHistoryScreenState();
}

class _MatchHistoryScreenState extends State<MatchHistoryScreen> {
  MatchHistoryController? _controller;
  final ScrollController _scrollController = ScrollController();

  @override
  void initState() {
    super.initState();
    final auth = widget.authController.state;
    if (auth is AuthAuthenticated) {
      final controller = MatchHistoryController(
        widget.repository,
        widget.gamesRepository,
        myUserId: auth.user.id,
      );
      _controller = controller;
      controller.load();
    }
    _scrollController.addListener(_onScroll);
  }

  void _onScroll() {
    if (!_scrollController.hasClients) {
      return;
    }
    if (_scrollController.position.extentAfter < 300) {
      _controller?.loadMore();
    }
  }

  @override
  void dispose() {
    _scrollController
      ..removeListener(_onScroll)
      ..dispose();
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    return Scaffold(
      appBar: AppBar(title: const Text('Match history')),
      body: SafeArea(
        child: controller == null
            ? const ErrorRetryView(
                message: 'Sign in to see your match history.',
              )
            : ListenableBuilder(
                listenable: controller,
                builder: (context, _) {
                  final state = controller.state;
                  return switch (state) {
                    MatchHistoryLoading() => const LoadingView(),
                    MatchHistoryError(message: final message) =>
                      ErrorRetryView(message: message, onRetry: controller.load),
                    MatchHistoryUnauthorized() => _SessionExpired(
                      onSignIn: widget.authController.logout,
                    ),
                    final MatchHistoryLoaded loaded => _buildLoaded(
                      context,
                      controller,
                      loaded,
                    ),
                  };
                },
              ),
      ),
    );
  }

  Widget _buildLoaded(
    BuildContext context,
    MatchHistoryController controller,
    MatchHistoryLoaded state,
  ) {
    if (state.items.isEmpty) {
      return const EmptyStateView(
        message: 'No matches yet. Play a game and it will show up here.',
      );
    }

    final showFooter =
        state.hasMore || state.isLoadingMore || state.loadMoreError != null;
    return ListView.builder(
      controller: _scrollController,
      padding: const EdgeInsets.all(AppSpacing.lg),
      itemCount: state.items.length + (showFooter ? 1 : 0),
      itemBuilder: (context, index) {
        if (index < state.items.length) {
          return Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.md),
            child: _MatchTile(item: state.items[index]),
          );
        }
        return _Footer(state: state, onLoadMore: controller.loadMore);
      },
    );
  }
}

class _SessionExpired extends StatelessWidget {
  const _SessionExpired({required this.onSignIn});

  final VoidCallback onSignIn;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Your session has expired. Please sign in again.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: AppSpacing.lg),
            OutlinedButton(
              onPressed: onSignIn,
              child: const Text('Sign in again'),
            ),
          ],
        ),
      ),
    );
  }
}

class _Footer extends StatelessWidget {
  const _Footer({required this.state, required this.onLoadMore});

  final MatchHistoryLoaded state;
  final VoidCallback onLoadMore;

  @override
  Widget build(BuildContext context) {
    if (state.isLoadingMore) {
      return const Padding(
        padding: EdgeInsets.all(AppSpacing.lg),
        child: Center(
          child: SizedBox(
            width: 24,
            height: 24,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }
    final error = state.loadMoreError;
    if (error != null) {
      return Column(
        children: [
          Text(error, textAlign: TextAlign.center),
          TextButton(onPressed: onLoadMore, child: const Text('Retry')),
        ],
      );
    }
    return Center(
      child: TextButton(onPressed: onLoadMore, child: const Text('Load more')),
    );
  }
}

Color _outcomeColor(MatchOutcome outcome) {
  switch (outcome) {
    case MatchOutcome.won:
      return AppColors.secondary;
    case MatchOutcome.lost:
      return AppColors.error;
    case MatchOutcome.inProgress:
      return AppColors.primary;
    case MatchOutcome.draw:
    case MatchOutcome.abandoned:
    case MatchOutcome.cancelled:
    case MatchOutcome.unrecorded:
      return AppColors.onSurfaceMuted;
  }
}

IconData _outcomeIcon(MatchOutcome outcome) {
  switch (outcome) {
    case MatchOutcome.won:
      return Icons.emoji_events;
    case MatchOutcome.lost:
      return Icons.close;
    case MatchOutcome.draw:
      return Icons.horizontal_rule;
    case MatchOutcome.abandoned:
      return Icons.link_off;
    case MatchOutcome.cancelled:
      return Icons.block;
    case MatchOutcome.inProgress:
      return Icons.hourglass_empty;
    case MatchOutcome.unrecorded:
      return Icons.help_outline;
  }
}

class _MatchTile extends StatelessWidget {
  const _MatchTile({required this.item});

  final MatchHistoryItem item;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final result = item.result;
    final color = _outcomeColor(result.outcome);
    final opponentId = item.opponentUserId;
    final detail = result.detail;

    return MergeSemantics(
      child: Material(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: opponentId == null
              ? null
              : () => context.push('/players/$opponentId'),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ExcludeSemantics(
                  child: Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: color.withValues(alpha: 0.18),
                    ),
                    child: Icon(_outcomeIcon(result.outcome), color: color),
                  ),
                ),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        result.label,
                        style: theme.textTheme.titleSmall?.copyWith(
                          color: color,
                        ),
                      ),
                      if (detail != null) Text(detail, style: theme.textTheme.bodySmall),
                      const SizedBox(height: AppSpacing.xs),
                      Text(
                        '${item.gameLabel} · vs ${item.opponentLabel}',
                        style: theme.textTheme.bodyMedium,
                      ),
                      const SizedBox(height: AppSpacing.xs),
                      Text(
                        formatShortDate(item.when.toLocal()),
                        style: theme.textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                if (opponentId != null)
                  const ExcludeSemantics(
                    child: Padding(
                      padding: EdgeInsets.only(left: AppSpacing.sm),
                      child: Icon(
                        Icons.chevron_right,
                        color: AppColors.onSurfaceMuted,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
