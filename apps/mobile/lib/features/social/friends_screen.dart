import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/auth_controller.dart';
import '../../core/auth/auth_state.dart';
import '../../core/games/game_models.dart';
import '../../core/social/friends_hub_controller.dart';
import '../../core/social/paged_list_controller.dart';
import '../../core/social/social_models.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_radii.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/widgets/loading_view.dart';
import '../../core/widgets/player_avatar.dart';
import '../../core/widgets/session_expired_view.dart';

/// Builds the controller for one Friends screen, for the signed-in player.
typedef FriendsHubFactory = FriendsHubController Function(String myUserId);

/// Friends, friend requests and blocked players in one place (Phase 12 PR 5):
/// three tabs - **Friends** (with presence and a Challenge action),
/// **Requests** (incoming and sent) and **Blocked** - plus a "Find a player"
/// search by exact username.
///
/// The screen shows only what the server has confirmed. Every action goes to
/// the API; the lists change when it answers (and are then re-fetched), and a
/// failure is shown with the server's own reason. An action already in flight
/// for a request or a player cannot be started twice.
///
/// The screen owns its [FriendsHubController]: created once in [initState] for
/// the signed-in player and disposed with the screen (which also removes its
/// realtime listeners). Networking never happens in `build`.
class FriendsScreen extends StatefulWidget {
  const FriendsScreen({
    super.key,
    required this.authController,
    required this.createController,
  });

  final AuthController authController;
  final FriendsHubFactory createController;

  @override
  State<FriendsScreen> createState() => _FriendsScreenState();
}

class _FriendsScreenState extends State<FriendsScreen> {
  FriendsHubController? _hub;

  @override
  void initState() {
    super.initState();
    final auth = widget.authController.state;
    if (auth is AuthAuthenticated) {
      final hub = widget.createController(auth.user.id);
      _hub = hub;
      hub.start();
    }
  }

  @override
  void dispose() {
    _hub?.dispose();
    super.dispose();
  }

  void _signInAgain() => widget.authController.logout();

  /// Runs an action, then tells the player what the server said. Returns
  /// whether it succeeded.
  Future<bool> _handle(
    Future<SocialActionResult> action, {
    GameInfo? challengedGame,
  }) async {
    final result = await action;
    if (!mounted) {
      return false;
    }
    final messenger = ScaffoldMessenger.of(context);
    final router = GoRouter.of(context);
    switch (result) {
      case SocialActionSuccess(message: final message):
        messenger.showSnackBar(
          SnackBar(
            content: Text(message),
            action: challengedGame == null
                ? null
                : SnackBarAction(
                    label: 'Open lobby',
                    onPressed: () => router.push(
                      '/games/${challengedGame.id}'
                      '?name=${Uri.encodeQueryComponent(challengedGame.displayName)}',
                    ),
                  ),
          ),
        );
        return true;
      case SocialActionFailure(
        message: final message,
        sessionExpired: final expired,
      ):
        messenger.showSnackBar(
          SnackBar(
            content: Text(message),
            action: expired
                ? SnackBarAction(
                    label: 'Sign in again',
                    onPressed: _signInAgain,
                  )
                : null,
          ),
        );
        return false;
      case SocialActionBusy():
        return false;
    }
  }

  Future<bool> _confirm({
    required String title,
    required String message,
    required String confirmLabel,
  }) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(confirmLabel),
          ),
        ],
      ),
    );
    return confirmed ?? false;
  }

  Future<void> _removeFriend(
    FriendsHubController hub,
    FriendInfo friend,
  ) async {
    final confirmed = await _confirm(
      title: 'Remove ${friend.displayLabel}?',
      message:
          'You will no longer be friends. You can send a new request later.',
      confirmLabel: 'Remove',
    );
    if (confirmed) {
      await _handle(hub.removeFriend(friend));
    }
  }

  Future<void> _blockPlayer(
    FriendsHubController hub,
    String userId,
    String name,
  ) async {
    final confirmed = await _confirm(
      title: 'Block $name?',
      message:
          'You will no longer be friends, any pending requests and challenges '
          'between you are cancelled, and neither of you can challenge the '
          'other. Unblocking later does not restore them.',
      confirmLabel: 'Block',
    );
    if (confirmed) {
      await _handle(hub.blockPlayer(userId, name));
    }
  }

  Future<void> _challenge(FriendsHubController hub, FriendInfo friend) async {
    final game = await showModalBottomSheet<GameInfo>(
      context: context,
      isScrollControlled: true,
      builder: (context) =>
          _GamePickerSheet(hub: hub, friendName: friend.displayLabel),
    );
    if (game == null || !mounted) {
      return;
    }
    await _handle(hub.challengeFriend(friend, game), challengedGame: game);
  }

  Future<void> _openFindPlayer(FriendsHubController hub) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(sheetContext).bottom,
        ),
        child: _FindPlayerSheet(
          hub: hub,
          onAction: _handle,
          onSignIn: _signInAgain,
          onOpenProfile: (userId) {
            Navigator.of(sheetContext).pop();
            context.push('/players/$userId');
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final hub = _hub;
    if (hub == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Friends')),
        body: const SafeArea(
          child: Center(
            child: Padding(
              padding: EdgeInsets.all(AppSpacing.xl),
              child: Text(
                'Sign in to see your friends.',
                textAlign: TextAlign.center,
              ),
            ),
          ),
        ),
      );
    }

    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Friends'),
          actions: [
            IconButton(
              icon: const Icon(Icons.person_add_alt_1),
              tooltip: 'Find a player',
              onPressed: () => _openFindPlayer(hub),
            ),
          ],
          bottom: const TabBar(
            tabs: [
              Tab(text: 'Friends'),
              Tab(text: 'Requests'),
              Tab(text: 'Blocked'),
            ],
          ),
        ),
        body: SafeArea(
          child: ListenableBuilder(
            listenable: hub.lists,
            builder: (context, _) => TabBarView(
              children: [_friendsTab(hub), _requestsTab(hub), _blockedTab(hub)],
            ),
          ),
        ),
      ),
    );
  }

  // ---- tabs ---------------------------------------------------------------

  Widget _friendsTab(FriendsHubController hub) {
    if (hub.friends.state is PagedListUnauthorized<FriendInfo>) {
      return SessionExpiredView(onSignIn: _signInAgain);
    }
    return _refreshable(
      onRefresh: hub.friends.reload,
      children: _pagedChildren<FriendInfo>(
        list: hub.friends,
        emptyMessage:
            'No friends yet. Tap the add-player button to find someone by '
            'username.',
        onSignIn: _signInAgain,
        itemBuilder: (friend) => _FriendTile(
          friend: friend,
          busy: hub.isPlayerBusy(friend.userId),
          onOpenProfile: () => context.push('/players/${friend.userId}'),
          onChallenge: () => _challenge(hub, friend),
          onRemove: () => _removeFriend(hub, friend),
          onBlock: () => _blockPlayer(hub, friend.userId, friend.displayLabel),
        ),
      ),
    );
  }

  Widget _requestsTab(FriendsHubController hub) {
    return _refreshable(
      onRefresh: hub.refreshAll,
      children: [
        const _SectionHeader('Incoming'),
        ..._pagedChildren<FriendRequestInfo>(
          list: hub.incoming,
          emptyMessage: 'No incoming friend requests.',
          onSignIn: _signInAgain,
          itemBuilder: (request) => _IncomingRequestTile(
            request: request,
            busy: hub.isRequestBusy(request.id),
            onOpenProfile: () => context.push('/players/${request.player.id}'),
            onAccept: () => _handle(hub.acceptRequest(request)),
            onDecline: () => _handle(hub.declineRequest(request)),
          ),
        ),
        const SizedBox(height: AppSpacing.lg),
        const _SectionHeader('Sent'),
        ..._pagedChildren<FriendRequestInfo>(
          list: hub.outgoing,
          emptyMessage: 'You have no pending sent requests.',
          onSignIn: _signInAgain,
          itemBuilder: (request) => _SentRequestTile(
            request: request,
            busy: hub.isRequestBusy(request.id),
            onOpenProfile: () => context.push('/players/${request.player.id}'),
            onCancel: () => _handle(hub.cancelRequest(request)),
          ),
        ),
      ],
    );
  }

  Widget _blockedTab(FriendsHubController hub) {
    if (hub.blocked.state is PagedListUnauthorized<BlockedPlayer>) {
      return SessionExpiredView(onSignIn: _signInAgain);
    }
    return _refreshable(
      onRefresh: hub.blocked.reload,
      children: [
        const _InfoNote(
          'Blocked players cannot challenge you or send you friend requests, '
          'and you cannot challenge them. Unblocking does not bring back an '
          'old friendship or request.',
        ),
        ..._pagedChildren<BlockedPlayer>(
          list: hub.blocked,
          emptyMessage: "You haven't blocked anyone.",
          onSignIn: _signInAgain,
          itemBuilder: (player) => _BlockedTile(
            player: player,
            busy: hub.isPlayerBusy(player.userId),
            onOpenProfile: () => context.push('/players/${player.userId}'),
            onUnblock: () => _handle(hub.unblockPlayer(player)),
          ),
        ),
      ],
    );
  }

  Widget _refreshable({
    required Future<void> Function() onRefresh,
    required List<Widget> children,
  }) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(AppSpacing.lg),
        children: children,
      ),
    );
  }
}

/// The widgets for one paged list: a spinner, an inline error with Retry, an
/// empty message, or the items followed by a "Load more" footer.
List<Widget> _pagedChildren<T>({
  required PagedListController<T> list,
  required Widget Function(T item) itemBuilder,
  required String emptyMessage,
  required VoidCallback onSignIn,
}) {
  final state = list.state;
  if (state is PagedListLoading<T>) {
    return const [
      Padding(
        padding: EdgeInsets.symmetric(vertical: AppSpacing.xl),
        child: Center(child: CircularProgressIndicator()),
      ),
    ];
  }
  if (state is PagedListError<T>) {
    return [
      _InlineMessage(
        message: state.message,
        actionLabel: 'Retry',
        onAction: list.load,
      ),
    ];
  }
  if (state is PagedListUnauthorized<T>) {
    return [
      _InlineMessage(
        message: 'Your session has expired. Please sign in again.',
        actionLabel: 'Sign in again',
        onAction: onSignIn,
      ),
    ];
  }
  if (state is PagedListLoaded<T>) {
    if (state.items.isEmpty) {
      return [_InfoNote(emptyMessage)];
    }
    return [
      for (final item in state.items)
        Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.md),
          child: itemBuilder(item),
        ),
      if (state.isLoadingMore)
        const Padding(
          padding: EdgeInsets.all(AppSpacing.lg),
          child: Center(
            child: SizedBox(
              width: 24,
              height: 24,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ),
        )
      else if (state.loadMoreError != null)
        _InlineMessage(
          message: state.loadMoreError!,
          actionLabel: 'Retry',
          onAction: list.loadMore,
        )
      else if (state.hasMore)
        Center(
          child: TextButton(
            onPressed: list.loadMore,
            child: const Text('Load more'),
          ),
        ),
    ];
  }
  return const [LoadingView()];
}

// ---- small widgets ---------------------------------------------------------

class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.title);

  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Text(title, style: Theme.of(context).textTheme.titleMedium),
    );
  }
}

class _InfoNote extends StatelessWidget {
  const _InfoNote(this.message);

  final String message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Text(
        message,
        style: Theme.of(
          context,
        ).textTheme.bodyMedium?.copyWith(color: AppColors.onSurfaceMuted),
      ),
    );
  }
}

class _InlineMessage extends StatelessWidget {
  const _InlineMessage({
    required this.message,
    required this.actionLabel,
    required this.onAction,
  });

  final String message;
  final String actionLabel;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
      child: Column(
        children: [
          Text(message, textAlign: TextAlign.center),
          const SizedBox(height: AppSpacing.sm),
          OutlinedButton(onPressed: onAction, child: Text(actionLabel)),
        ],
      ),
    );
  }
}

/// A rounded row card: avatar, a text block, and whatever [trailing] adds.
class _PlayerCard extends StatelessWidget {
  const _PlayerCard({
    required this.name,
    required this.handle,
    required this.onTap,
    this.subtitle,
    this.subtitleColor,
    this.trailing,
    this.below,
  });

  final String name;
  final String handle;
  final VoidCallback onTap;
  final String? subtitle;
  final Color? subtitleColor;
  final Widget? trailing;

  /// Extra content under the text block (e.g. action buttons).
  final Widget? below;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitle = this.subtitle;
    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(AppRadii.lg),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  PlayerAvatar(name: name),
                  const SizedBox(width: AppSpacing.md),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          name,
                          style: theme.textTheme.titleSmall,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        Text(
                          '@$handle',
                          style: theme.textTheme.bodySmall,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        if (subtitle != null)
                          Text(
                            subtitle,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: subtitleColor,
                            ),
                          ),
                      ],
                    ),
                  ),
                  ?trailing,
                ],
              ),
              if (below != null) ...[
                const SizedBox(height: AppSpacing.sm),
                below!,
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _BusyIndicator extends StatelessWidget {
  const _BusyIndicator();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.all(AppSpacing.md),
      child: SizedBox(
        width: 20,
        height: 20,
        child: CircularProgressIndicator(strokeWidth: 2),
      ),
    );
  }
}

Color _presenceColor(FriendPresence presence) {
  switch (presence) {
    case FriendPresence.online:
      return AppColors.secondary;
    case FriendPresence.inMatch:
    case FriendPresence.searching:
      return AppColors.primary;
    case FriendPresence.offline:
      return AppColors.onSurfaceMuted;
  }
}

class _FriendTile extends StatelessWidget {
  const _FriendTile({
    required this.friend,
    required this.busy,
    required this.onOpenProfile,
    required this.onChallenge,
    required this.onRemove,
    required this.onBlock,
  });

  final FriendInfo friend;
  final bool busy;
  final VoidCallback onOpenProfile;
  final VoidCallback onChallenge;
  final VoidCallback onRemove;
  final VoidCallback onBlock;

  @override
  Widget build(BuildContext context) {
    return _PlayerCard(
      name: friend.displayLabel,
      handle: friend.username,
      subtitle: friend.presence.label,
      subtitleColor: _presenceColor(friend.presence),
      onTap: onOpenProfile,
      trailing: busy
          ? const _BusyIndicator()
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  icon: const Icon(Icons.sports_esports),
                  tooltip: 'Challenge ${friend.displayLabel}',
                  onPressed: onChallenge,
                ),
                PopupMenuButton<String>(
                  tooltip: 'More options for ${friend.displayLabel}',
                  onSelected: (value) {
                    switch (value) {
                      case 'profile':
                        onOpenProfile();
                      case 'remove':
                        onRemove();
                      case 'block':
                        onBlock();
                    }
                  },
                  itemBuilder: (context) => const [
                    PopupMenuItem(
                      value: 'profile',
                      child: Text('View profile'),
                    ),
                    PopupMenuItem(
                      value: 'remove',
                      child: Text('Remove friend'),
                    ),
                    PopupMenuItem(value: 'block', child: Text('Block')),
                  ],
                ),
              ],
            ),
    );
  }
}

class _IncomingRequestTile extends StatelessWidget {
  const _IncomingRequestTile({
    required this.request,
    required this.busy,
    required this.onOpenProfile,
    required this.onAccept,
    required this.onDecline,
  });

  final FriendRequestInfo request;
  final bool busy;
  final VoidCallback onOpenProfile;
  final VoidCallback onAccept;
  final VoidCallback onDecline;

  @override
  Widget build(BuildContext context) {
    return _PlayerCard(
      name: request.player.displayLabel,
      handle: request.player.username,
      subtitle: 'Wants to be your friend',
      onTap: onOpenProfile,
      trailing: busy ? const _BusyIndicator() : null,
      below: Wrap(
        spacing: AppSpacing.sm,
        runSpacing: AppSpacing.xs,
        children: [
          FilledButton(
            onPressed: busy ? null : onAccept,
            child: const Text('Accept'),
          ),
          OutlinedButton(
            onPressed: busy ? null : onDecline,
            child: const Text('Decline'),
          ),
        ],
      ),
    );
  }
}

class _SentRequestTile extends StatelessWidget {
  const _SentRequestTile({
    required this.request,
    required this.busy,
    required this.onOpenProfile,
    required this.onCancel,
  });

  final FriendRequestInfo request;
  final bool busy;
  final VoidCallback onOpenProfile;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    return _PlayerCard(
      name: request.player.displayLabel,
      handle: request.player.username,
      subtitle: 'Request sent',
      onTap: onOpenProfile,
      trailing: busy
          ? const _BusyIndicator()
          : TextButton(onPressed: onCancel, child: const Text('Cancel')),
    );
  }
}

class _BlockedTile extends StatelessWidget {
  const _BlockedTile({
    required this.player,
    required this.busy,
    required this.onOpenProfile,
    required this.onUnblock,
  });

  final BlockedPlayer player;
  final bool busy;
  final VoidCallback onOpenProfile;
  final VoidCallback onUnblock;

  @override
  Widget build(BuildContext context) {
    return _PlayerCard(
      name: player.displayLabel,
      handle: player.username,
      subtitle: 'Blocked ${formatShortDate(player.blockedAt.toLocal())}',
      onTap: onOpenProfile,
      trailing: busy
          ? const _BusyIndicator()
          : TextButton(onPressed: onUnblock, child: const Text('Unblock')),
    );
  }
}

// ---- challenge game picker -------------------------------------------------

class _GamePickerSheet extends StatefulWidget {
  const _GamePickerSheet({required this.hub, required this.friendName});

  final FriendsHubController hub;
  final String friendName;

  @override
  State<_GamePickerSheet> createState() => _GamePickerSheetState();
}

class _GamePickerSheetState extends State<_GamePickerSheet> {
  late Future<GamesLoadResult> _games;

  @override
  void initState() {
    super.initState();
    _games = widget.hub.loadGames();
  }

  void _retry() {
    setState(() => _games = widget.hub.loadGames());
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Challenge ${widget.friendName}',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Choose a game. This is a free-play challenge.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: AppSpacing.md),
            FutureBuilder<GamesLoadResult>(
              future: _games,
              builder: (context, snapshot) {
                final result = snapshot.data;
                if (result == null) {
                  return const Padding(
                    padding: EdgeInsets.all(AppSpacing.lg),
                    child: Center(child: CircularProgressIndicator()),
                  );
                }
                final error = result.error;
                if (error != null) {
                  return Column(
                    children: [
                      Text(error, textAlign: TextAlign.center),
                      const SizedBox(height: AppSpacing.sm),
                      if (!result.sessionExpired)
                        OutlinedButton(
                          onPressed: _retry,
                          child: const Text('Retry'),
                        ),
                    ],
                  );
                }
                if (result.games.isEmpty) {
                  return const Text('No games are available right now.');
                }
                return Flexible(
                  child: ListView(
                    shrinkWrap: true,
                    children: [
                      for (final game in result.games)
                        ListTile(
                          leading: const Icon(Icons.sports_esports),
                          title: Text(game.displayName),
                          subtitle: const Text('Free play'),
                          onTap: () => Navigator.of(context).pop(game),
                        ),
                    ],
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

// ---- find a player ---------------------------------------------------------

class _FindPlayerSheet extends StatefulWidget {
  const _FindPlayerSheet({
    required this.hub,
    required this.onAction,
    required this.onSignIn,
    required this.onOpenProfile,
  });

  final FriendsHubController hub;
  final Future<bool> Function(Future<SocialActionResult> action) onAction;
  final VoidCallback onSignIn;
  final void Function(String userId) onOpenProfile;

  @override
  State<_FindPlayerSheet> createState() => _FindPlayerSheetState();
}

class _FindPlayerSheetState extends State<_FindPlayerSheet> {
  final TextEditingController _username = TextEditingController();
  LookupOutcome? _outcome;
  bool _searching = false;

  @override
  void dispose() {
    _username.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    if (_searching) {
      return;
    }
    setState(() {
      _searching = true;
      _outcome = null;
    });
    final outcome = await widget.hub.lookup(_username.text);
    if (!mounted) {
      return;
    }
    setState(() {
      _searching = false;
      _outcome = outcome;
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Find a player', style: theme.textTheme.titleMedium),
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Enter their exact username.',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: AppSpacing.md),
            TextField(
              controller: _username,
              enabled: !_searching,
              autocorrect: false,
              textInputAction: TextInputAction.search,
              decoration: const InputDecoration(
                labelText: 'Username',
                prefixText: '@',
              ),
              onSubmitted: (_) => _search(),
            ),
            const SizedBox(height: AppSpacing.md),
            FilledButton(
              onPressed: _searching ? null : _search,
              child: _searching
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Search'),
            ),
            const SizedBox(height: AppSpacing.md),
            _buildOutcome(context),
          ],
        ),
      ),
    );
  }

  Widget _buildOutcome(BuildContext context) {
    final outcome = _outcome;
    if (outcome == null || outcome is LookupBusy) {
      return const SizedBox.shrink();
    }
    if (outcome is LookupNotFound) {
      return const Text(
        'No player found with that username.',
        textAlign: TextAlign.center,
      );
    }
    if (outcome is LookupIsSelf) {
      return const Text("That's you.", textAlign: TextAlign.center);
    }
    if (outcome is LookupFailed) {
      return Column(
        children: [
          Text(outcome.message, textAlign: TextAlign.center),
          if (outcome.sessionExpired) ...[
            const SizedBox(height: AppSpacing.sm),
            OutlinedButton(
              onPressed: widget.onSignIn,
              child: const Text('Sign in again'),
            ),
          ],
        ],
      );
    }
    if (outcome is LookupFound) {
      return ListenableBuilder(
        listenable: widget.hub.lists,
        builder: (context, _) => _FoundPlayerCard(
          hub: widget.hub,
          player: outcome.player,
          onAction: widget.onAction,
          onOpenProfile: widget.onOpenProfile,
        ),
      );
    }
    return const SizedBox.shrink();
  }
}

class _FoundPlayerCard extends StatelessWidget {
  const _FoundPlayerCard({
    required this.hub,
    required this.player,
    required this.onAction,
    required this.onOpenProfile,
  });

  final FriendsHubController hub;
  final PlayerLookupResult player;
  final Future<bool> Function(Future<SocialActionResult> action) onAction;
  final void Function(String userId) onOpenProfile;

  @override
  Widget build(BuildContext context) {
    final busy = hub.isPlayerBusy(player.id);
    final relation = hub.relationTo(player.id);

    final Widget primary;
    switch (relation) {
      case PlayerRelation.friend:
        primary = const OutlinedButton(
          onPressed: null,
          child: Text('Already friends'),
        );
      case PlayerRelation.requestSent:
        primary = const OutlinedButton(
          onPressed: null,
          child: Text('Request sent'),
        );
      case PlayerRelation.requestReceived:
        final request = hub.incomingRequestFrom(player.id);
        primary = FilledButton(
          onPressed: busy || request == null
              ? null
              : () => onAction(hub.acceptRequest(request)),
          child: const Text('Accept their request'),
        );
      case PlayerRelation.blocked:
        final entry = hub.blockedEntryFor(player.id);
        primary = OutlinedButton(
          onPressed: busy || entry == null
              ? null
              : () => onAction(hub.unblockPlayer(entry)),
          child: const Text('Unblock'),
        );
      case PlayerRelation.none:
        primary = FilledButton(
          onPressed: busy
              ? null
              : () async {
                  final sent = await onAction(
                    hub.sendFriendRequest(player.id, player.username),
                  );
                  if (sent && context.mounted) {
                    Navigator.of(context).pop();
                  }
                },
          child: busy
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Add friend'),
        );
    }

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppRadii.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              PlayerAvatar(name: player.username),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Text(
                  '@${player.username}',
                  style: Theme.of(context).textTheme.titleSmall,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.xs,
            children: [
              primary,
              TextButton(
                onPressed: () => onOpenProfile(player.id),
                child: const Text('View profile'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
