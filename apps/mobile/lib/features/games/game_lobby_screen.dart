import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/auth/auth_state.dart';
import '../../core/challenges/challenge_models.dart';
import '../../core/challenges/challenges_controller.dart';
import '../../core/challenges/challenges_state.dart';
import '../../core/errors/app_exception.dart';
import '../../core/matchmaking/matchmaking_controller.dart';
import '../../core/matchmaking/matchmaking_state.dart';
import '../../core/theme/app_colors.dart';

/// Per-game lobby: "Find Opponent" (matchmaking) or challenge a specific
/// player by username, plus this game's pending challenges. Reacts
/// purely to controller state — it never decides on its own whether a
/// match has formed.
class GameLobbyScreen extends StatefulWidget {
  const GameLobbyScreen({
    super.key,
    required this.gameId,
    required this.gameDisplayName,
    required this.authController,
    required this.matchmakingController,
    required this.challengesController,
  });

  final String gameId;
  final String gameDisplayName;
  final AuthController authController;
  final MatchmakingController matchmakingController;
  final ChallengesController challengesController;

  @override
  State<GameLobbyScreen> createState() => _GameLobbyScreenState();
}

class _GameLobbyScreenState extends State<GameLobbyScreen> {
  String? _navigatedMatchId;

  @override
  void initState() {
    super.initState();
    widget.challengesController.refresh();
    widget.matchmakingController.addListener(_onMatchmakingChanged);
  }

  @override
  void dispose() {
    widget.matchmakingController.removeListener(_onMatchmakingChanged);
    super.dispose();
  }

  void _onMatchmakingChanged() {
    final state = widget.matchmakingController.state;
    if (state is MatchmakingMatched) {
      _goToMatch(state.matchId);
    }
  }

  void _goToMatch(String matchId) {
    if (_navigatedMatchId == matchId) return;
    _navigatedMatchId = matchId;
    context.push('/matches/$matchId');
  }

  Future<void> _challengePlayer() async {
    final username = await showDialog<String>(
      context: context,
      builder: (context) => _ChallengeUsernameDialog(),
    );
    if (username == null || username.trim().isEmpty) return;

    try {
      await widget.challengesController.challengeByUsername(
        widget.gameId,
        username.trim(),
      );
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Challenge sent to $username')));
      }
    } on AppException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final authState = widget.authController.state;
    final userId = authState is AuthAuthenticated ? authState.user.id : null;

    return Scaffold(
      appBar: AppBar(title: Text(widget.gameDisplayName)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            ListenableBuilder(
              listenable: widget.matchmakingController,
              builder: (context, _) {
                final state = widget.matchmakingController.state;
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (state is MatchmakingSearching)
                      _SearchingBanner(
                        onCancel: widget.matchmakingController.cancel,
                      )
                    else ...[
                      FilledButton.icon(
                        icon: const Icon(Icons.search),
                        label: const Text('Find Opponent'),
                        onPressed: () =>
                            widget.matchmakingController.join(widget.gameId),
                      ),
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                        icon: const Icon(Icons.person_add_alt_1),
                        label: const Text('Challenge a Player'),
                        onPressed: _challengePlayer,
                      ),
                    ],
                    if (state is MatchmakingError) ...[
                      const SizedBox(height: 12),
                      Text(
                        state.message,
                        style: TextStyle(color: AppColors.error),
                      ),
                    ],
                  ],
                );
              },
            ),
            const SizedBox(height: 32),
            Text('Challenges', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            ListenableBuilder(
              listenable: widget.challengesController,
              builder: (context, _) {
                final state = widget.challengesController.state;
                return switch (state) {
                  ChallengesLoading() => const Padding(
                    padding: EdgeInsets.symmetric(vertical: 16),
                    child: Center(child: CircularProgressIndicator()),
                  ),
                  ChallengesLoadError(message: final message) => Text(message),
                  ChallengesLoaded(challenges: final all) => _ChallengeList(
                    challenges: all
                        .where((c) => c.gameId == widget.gameId)
                        .toList(),
                    currentUserId: userId,
                    controller: widget.challengesController,
                    onAccepted: _goToMatch,
                  ),
                };
              },
            ),
          ],
        ),
      ),
    );
  }
}

class _SearchingBanner extends StatelessWidget {
  const _SearchingBanner({required this.onCancel});

  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          const SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: 16),
          const Expanded(child: Text('Searching for an opponent…')),
          TextButton(onPressed: onCancel, child: const Text('Cancel')),
        ],
      ),
    );
  }
}

class _ChallengeList extends StatelessWidget {
  const _ChallengeList({
    required this.challenges,
    required this.currentUserId,
    required this.controller,
    required this.onAccepted,
  });

  final List<ChallengeInfo> challenges;
  final String? currentUserId;
  final ChallengesController controller;
  final void Function(String matchId) onAccepted;

  @override
  Widget build(BuildContext context) {
    final pending = challenges.where((c) => c.status == 'PENDING').toList();
    if (pending.isEmpty) {
      return Text(
        'No pending challenges.',
        style: Theme.of(
          context,
        ).textTheme.bodySmall?.copyWith(color: AppColors.onSurfaceMuted),
      );
    }

    return Column(
      children: pending.map((challenge) {
        final isIncoming =
            currentUserId != null && challenge.isIncomingFor(currentUserId!);
        return Card(
          margin: const EdgeInsets.only(bottom: 8),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    isIncoming ? 'Incoming challenge' : 'Challenge sent',
                  ),
                ),
                if (isIncoming) ...[
                  TextButton(
                    onPressed: () async {
                      final resolved = await controller
                          .accept(challenge.id)
                          .then((_) => challenge.matchId);
                      if (resolved != null) onAccepted(resolved);
                    },
                    child: const Text('Accept'),
                  ),
                  TextButton(
                    onPressed: () => controller.decline(challenge.id),
                    child: const Text('Decline'),
                  ),
                ] else
                  TextButton(
                    onPressed: () => controller.cancel(challenge.id),
                    child: const Text('Cancel'),
                  ),
              ],
            ),
          ),
        );
      }).toList(),
    );
  }
}

class _ChallengeUsernameDialog extends StatefulWidget {
  @override
  State<_ChallengeUsernameDialog> createState() =>
      _ChallengeUsernameDialogState();
}

class _ChallengeUsernameDialogState extends State<_ChallengeUsernameDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Challenge a player'),
      content: TextField(
        controller: _controller,
        autofocus: true,
        decoration: const InputDecoration(labelText: 'Username'),
        onSubmitted: (value) => Navigator.of(context).pop(value),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_controller.text),
          child: const Text('Send'),
        ),
      ],
    );
  }
}
