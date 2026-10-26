import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/auth/auth_state.dart';
import '../../core/social/player_profile_controller.dart';
import '../../core/social/player_profile_state.dart';
import '../../core/social/social_models.dart';
import '../../core/social/social_repository.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_radii.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/widgets/error_retry_view.dart';
import '../../core/widgets/loading_view.dart';
import '../../core/widgets/player_avatar.dart';
import '../../core/widgets/surface_card.dart';

/// A player's public profile: who they are and their win/draw/loss record
/// from completed matches (Phase 12, `GET /users/:id/profile`). Used for the
/// signed-in player's own profile and for anyone else's.
///
/// It shows exactly what the profile endpoint returns and nothing else: no
/// email, phone, date of birth, wallet, stake or transaction data is ever
/// requested or displayed, and there is no avatar image (the API has none), so
/// the player's initials are shown instead.
///
/// The screen owns its [PlayerProfileController]: created once in
/// [initState], replaced only if [userId] changes, disposed with the screen.
/// Network calls never happen in `build`.
class PlayerProfileScreen extends StatefulWidget {
  const PlayerProfileScreen({
    super.key,
    required this.userId,
    required this.repository,
    required this.authController,
  });

  final String userId;
  final SocialRepository repository;

  /// Used to recognise the player's own profile, and to sign them out when
  /// their session turns out to have expired.
  final AuthController authController;

  @override
  State<PlayerProfileScreen> createState() => _PlayerProfileScreenState();
}

class _PlayerProfileScreenState extends State<PlayerProfileScreen> {
  late PlayerProfileController _controller;

  @override
  void initState() {
    super.initState();
    _controller = _createController();
    _controller.load();
  }

  PlayerProfileController _createController() {
    return PlayerProfileController(widget.repository, userId: widget.userId);
  }

  @override
  void didUpdateWidget(PlayerProfileScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.userId != widget.userId ||
        !identical(oldWidget.repository, widget.repository)) {
      _controller.dispose();
      _controller = _createController();
      _controller.load();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = widget.authController.state;
    final myUserId = auth is AuthAuthenticated ? auth.user.id : null;
    final isOwn = myUserId != null && myUserId == widget.userId;

    return Scaffold(
      appBar: AppBar(title: Text(isOwn ? 'My profile' : 'Player profile')),
      body: SafeArea(
        child: ListenableBuilder(
          listenable: _controller,
          builder: (context, _) {
            final state = _controller.state;
            return switch (state) {
              PlayerProfileLoading() => const LoadingView(),
              PlayerProfileLoaded(profile: final profile) => _ProfileContent(
                profile: profile,
                isOwn: isOwn,
              ),
              PlayerProfileNotFound() => _ProfileMessage(
                icon: Icons.person_off_outlined,
                title: 'Player not found',
                message: "This player isn't available.",
                actionLabel: 'Go back',
                onAction: () => _goBack(context),
              ),
              PlayerProfileUnauthorized() => _ProfileMessage(
                icon: Icons.lock_outline,
                title: 'Session expired',
                message: 'Your session has expired. Please sign in again.',
                actionLabel: 'Sign in again',
                onAction: widget.authController.logout,
              ),
              PlayerProfileError(message: final message) => ErrorRetryView(
                message: message,
                onRetry: _controller.load,
              ),
            };
          },
        ),
      ),
    );
  }

  void _goBack(BuildContext context) {
    if (context.canPop()) {
      context.pop();
    } else {
      context.go('/account');
    }
  }
}

class _ProfileMessage extends StatelessWidget {
  const _ProfileMessage({
    required this.icon,
    required this.title,
    required this.message,
    required this.actionLabel,
    required this.onAction,
  });

  final IconData icon;
  final String title;
  final String message;
  final String actionLabel;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 48, color: AppColors.onSurfaceMuted),
            const SizedBox(height: AppSpacing.lg),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(
              message,
              textAlign: TextAlign.center,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceMuted),
            ),
            const SizedBox(height: AppSpacing.xl),
            OutlinedButton(onPressed: onAction, child: Text(actionLabel)),
          ],
        ),
      ),
    );
  }
}

class _ProfileContent extends StatelessWidget {
  const _ProfileContent({required this.profile, required this.isOwn});

  final PlayerProfile profile;
  final bool isOwn;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _ProfileHeader(profile: profile, isOwn: isOwn),
          const SizedBox(height: AppSpacing.lg),
          _RecordCard(profile: profile),
          const SizedBox(height: AppSpacing.lg),
          _StatTiles(profile: profile),
        ],
      ),
    );
  }
}

class _ProfileHeader extends StatelessWidget {
  const _ProfileHeader({required this.profile, required this.isOwn});

  final PlayerProfile profile;
  final bool isOwn;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SurfaceCard(
      child: Column(
        children: [
          PlayerAvatar(name: profile.displayLabel, radius: 40),
          const SizedBox(height: AppSpacing.md),
          Text(
            profile.displayLabel,
            textAlign: TextAlign.center,
            style: theme.textTheme.headlineMedium,
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            '@${profile.username}',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall,
          ),
          if (isOwn) ...[
            const SizedBox(height: AppSpacing.md),
            Container(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.md,
                vertical: AppSpacing.xs,
              ),
              decoration: BoxDecoration(
                color: AppColors.primary.withValues(alpha: 0.18),
                borderRadius: BorderRadius.circular(AppRadii.sm),
              ),
              child: Text(
                'This is you',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: AppColors.onBackground,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

String _plural(int count, String singular, String plural) {
  return '$count ${count == 1 ? singular : plural}';
}

class _RecordCard extends StatelessWidget {
  const _RecordCard({required this.profile});

  final PlayerProfile profile;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SurfaceCard(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Games played', style: theme.textTheme.titleSmall),
          const SizedBox(height: AppSpacing.xs),
          Text('${profile.gamesPlayed}', style: theme.textTheme.headlineMedium),
          const SizedBox(height: AppSpacing.md),
          if (profile.gamesPlayed == 0)
            Text(
              'No completed games yet.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: AppColors.onSurfaceMuted,
              ),
            )
          else
            _ResultBar(
              wins: profile.wins,
              draws: profile.draws,
              losses: profile.losses,
            ),
        ],
      ),
    );
  }
}

/// A single bar split in proportion to wins, draws and losses. Purely a
/// picture of the three counts shown as numbers below it, so it is read to a
/// screen reader as one sentence rather than as three unlabelled colours.
class _ResultBar extends StatelessWidget {
  const _ResultBar({
    required this.wins,
    required this.draws,
    required this.losses,
  });

  final int wins;
  final int draws;
  final int losses;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label:
          '${_plural(wins, 'win', 'wins')}, '
          '${_plural(draws, 'draw', 'draws')}, '
          '${_plural(losses, 'loss', 'losses')}',
      child: ExcludeSemantics(
        child: ClipRRect(
          borderRadius: BorderRadius.circular(AppRadii.sm),
          child: SizedBox(
            height: 12,
            child: Row(
              children: [
                if (wins > 0)
                  Expanded(
                    flex: wins,
                    child: const ColoredBox(color: AppColors.secondary),
                  ),
                if (draws > 0)
                  Expanded(
                    flex: draws,
                    child: const ColoredBox(color: AppColors.onSurfaceMuted),
                  ),
                if (losses > 0)
                  Expanded(
                    flex: losses,
                    child: const ColoredBox(color: AppColors.error),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _StatTiles extends StatelessWidget {
  const _StatTiles({required this.profile});

  final PlayerProfile profile;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        const spacing = AppSpacing.md;
        final width = constraints.maxWidth;
        // Three across when each tile can be at least ~96 wide; otherwise
        // one per row, so nothing is squeezed on a small phone or at a large
        // text size.
        final threeAcross = ((width - 2 * spacing) / 3).floorToDouble();
        // Large system text also goes one per row: three tiles across would
        // leave each one too narrow for its number and label.
        final largeText = MediaQuery.textScalerOf(context).scale(14) > 14 * 1.3;
        final tileWidth = !largeText && threeAcross >= 96 ? threeAcross : width;
        return Wrap(
          spacing: spacing,
          runSpacing: spacing,
          children: [
            SizedBox(
              width: tileWidth,
              child: _StatTile(
                label: 'Wins',
                spoken: _plural(profile.wins, 'win', 'wins'),
                value: profile.wins,
                color: AppColors.secondary,
              ),
            ),
            SizedBox(
              width: tileWidth,
              child: _StatTile(
                label: 'Draws',
                spoken: _plural(profile.draws, 'draw', 'draws'),
                value: profile.draws,
                color: AppColors.onSurfaceMuted,
              ),
            ),
            SizedBox(
              width: tileWidth,
              child: _StatTile(
                label: 'Losses',
                spoken: _plural(profile.losses, 'loss', 'losses'),
                value: profile.losses,
                color: AppColors.error,
              ),
            ),
          ],
        );
      },
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile({
    required this.label,
    required this.spoken,
    required this.value,
    required this.color,
  });

  final String label;
  final String spoken;
  final int value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Semantics(
      label: spoken,
      child: ExcludeSemantics(
        child: Container(
          padding: const EdgeInsets.all(AppSpacing.md),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(AppRadii.md),
            border: Border.all(color: color.withValues(alpha: 0.5)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: Text(
                  '$value',
                  style: theme.textTheme.headlineSmall?.copyWith(color: color),
                ),
              ),
              const SizedBox(height: AppSpacing.xs),
              Text(label, style: theme.textTheme.labelSmall),
            ],
          ),
        ),
      ),
    );
  }
}
