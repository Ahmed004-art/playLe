import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:playle_mobile/core/auth/auth_state.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/social/social_models.dart';

import '../../core/social/fake_social_repository.dart';
import '../../core/social/friends_harness.dart';
import 'social_test_support.dart';

const _ada = PlayerSummary(
  id: opponentId,
  username: 'ada_l',
  displayName: 'Ada Lovelace',
);
const _grace = PlayerSummary(
  id: otherOpponentId,
  username: 'grace_h',
  displayName: 'Grace Hopper',
);

class _Opened {
  _Opened(this.harness, this.auth, this.router);

  final FriendsHarness harness;
  final SignedIn auth;
  final GoRouter router;

  FakeSocialRepository get social => harness.social;
}

Future<_Opened> _open(
  WidgetTester tester, {
  void Function(FriendsHarness harness)? seed,
  int pageSize = 20,
  bool settle = true,
  String location = '/friends',
}) async {
  final harness = FriendsHarness(pageSize: pageSize);
  harness.social.directory
    ..[_ada.id] = _ada
    ..[_grace.id] = _grace;
  seed?.call(harness);
  useTallScreen(tester);
  final auth = await signedIn();
  final router = buildSocialRouter(
    auth: auth.controller,
    social: harness.social,
    friends: harness,
    initialLocation: location,
  );
  await tester.pumpWidget(socialApp(router));
  if (settle) {
    await tester.pumpAndSettle();
  }
  return _Opened(harness, auth, router);
}

Future<void> _openTab(WidgetTester tester, String label) async {
  await tester.tap(find.widgetWithText(Tab, label));
  await tester.pumpAndSettle();
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  group('Friends tab', () {
    testWidgets('lists friends with their presence', (tester) async {
      await _open(
        tester,
        seed: (h) => h.social.friends.addAll([
          buildFriend(presence: FriendPresence.online),
          buildFriend(
            userId: _grace.id,
            username: 'grace_h',
            displayName: 'Grace Hopper',
            presence: FriendPresence.inMatch,
          ),
          buildFriend(
            userId: thirdPlayerId,
            username: 'alan_t',
            displayName: null,
          ),
        ]),
      );

      expect(find.text('Ada Lovelace'), findsOneWidget);
      expect(find.text('@ada_l'), findsOneWidget);
      expect(find.text('Online'), findsOneWidget);
      expect(find.text('Grace Hopper'), findsOneWidget);
      expect(find.text('In a match'), findsOneWidget);
      expect(find.text('alan_t'), findsOneWidget); // no display name
      expect(find.text('Offline'), findsOneWidget);
    });

    testWidgets('shows an empty state', (tester) async {
      await _open(tester);

      expect(find.textContaining('No friends yet.'), findsOneWidget);
    });

    testWidgets('shows a spinner while loading', (tester) async {
      await _open(
        tester,
        settle: false,
        seed: (h) => h.social.gates['friends'] = Completer<void>(),
      );
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsWidgets);
    });

    testWidgets('a failed load shows a retryable error, and Retry recovers', (
      tester,
    ) async {
      final opened = await _open(
        tester,
        seed: (h) {
          h.social.friends.add(buildFriend());
          h.social.errors['friends'] = const NetworkException('offline');
        },
      );
      expect(
        find.text(
          'Could not reach PlayLe. Check your connection and try again.',
        ),
        findsOneWidget,
      );

      opened.social.errors.remove('friends');
      await _tap(tester, find.text('Retry'));

      expect(find.text('Ada Lovelace'), findsOneWidget);
    });

    testWidgets('an expired session offers to sign in again', (tester) async {
      final opened = await _open(
        tester,
        seed: (h) => h.social.errors['friends'] = const NetworkException(
          'Unauthorized',
          statusCode: 401,
        ),
      );

      expect(
        find.text('Your session has expired. Please sign in again.'),
        findsOneWidget,
      );

      await _tap(tester, find.text('Sign in again'));

      expect(opened.auth.repository.loggedOut, isTrue);
      expect(opened.auth.controller.state, isA<AuthUnauthenticated>());
    });

    testWidgets('pages with Load more', (tester) async {
      final opened = await _open(
        tester,
        pageSize: 1,
        seed: (h) => h.social.friends.addAll([
          buildFriend(),
          buildFriend(
            userId: _grace.id,
            username: 'grace_h',
            displayName: 'Grace Hopper',
          ),
        ]),
      );
      expect(find.text('Ada Lovelace'), findsOneWidget);
      expect(find.text('Grace Hopper'), findsNothing);

      await _tap(tester, find.text('Load more'));

      expect(find.text('Grace Hopper'), findsOneWidget);
      expect(find.text('Load more'), findsNothing);
      expect(opened.social.friendCursors, [null, opponentId]);
    });

    testWidgets('tapping a friend opens their profile, and back returns', (
      tester,
    ) async {
      await _open(tester, seed: (h) => h.social.friends.add(buildFriend()));

      await _tap(tester, find.text('Ada Lovelace'));
      expect(find.text('Player profile'), findsOneWidget);

      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.text('Ada Lovelace'), findsOneWidget);
      expect(find.text('Player profile'), findsNothing);
    });

    testWidgets('without a signed-in player it says so and fetches nothing', (
      tester,
    ) async {
      final harness = FriendsHarness();
      useTallScreen(tester);
      final auth = await signedIn();
      await auth.controller.logout();
      final router = buildSocialRouter(
        auth: auth.controller,
        social: harness.social,
        friends: harness,
        initialLocation: '/friends',
      );
      await tester.pumpWidget(socialApp(router));
      await tester.pumpAndSettle();

      expect(find.text('Sign in to see your friends.'), findsOneWidget);
      expect(harness.social.callsTo('friends'), 0);
    });
  });

  group('challenging a friend', () {
    testWidgets('picks a game and sends a free-play challenge', (tester) async {
      final opened = await _open(
        tester,
        seed: (h) => h.social.friends.add(buildFriend()),
      );

      await _tap(tester, find.byTooltip('Challenge Ada Lovelace'));
      expect(find.text('Challenge Ada Lovelace'), findsOneWidget);
      expect(find.text('Free play'), findsOneWidget);
      await _tap(tester, find.text('Tic-Tac-Toe'));

      expect(
        find.textContaining('Challenge sent to Ada Lovelace for Tic-Tac-Toe'),
        findsOneWidget,
      );
      expect(opened.harness.challenges, [
        (gameId: 'tic_tac_toe', opponentId: opponentId),
      ]);
    });

    testWidgets('closing the picker sends nothing', (tester) async {
      final opened = await _open(
        tester,
        seed: (h) => h.social.friends.add(buildFriend()),
      );

      await _tap(tester, find.byTooltip('Challenge Ada Lovelace'));
      await tester.tapAt(const Offset(10, 10)); // dismiss the sheet
      await tester.pumpAndSettle();

      expect(opened.harness.challenges, isEmpty);
    });

    testWidgets('shows the server\'s reason when the challenge is refused', (
      tester,
    ) async {
      final opened = await _open(
        tester,
        seed: (h) => h.social.friends.add(buildFriend()),
      );
      opened.harness.challengeError = const NetworkException(
        'You are already in an active or pending match',
        statusCode: 409,
      );

      await _tap(tester, find.byTooltip('Challenge Ada Lovelace'));
      await _tap(tester, find.text('Tic-Tac-Toe'));

      expect(
        find.text('You are already in an active or pending match'),
        findsOneWidget,
      );
    });

    testWidgets('an unavailable player is reported plainly', (tester) async {
      final opened = await _open(
        tester,
        seed: (h) => h.social.friends.add(buildFriend()),
      );
      opened.harness.challengeError = const NetworkException(
        'Opponent not found',
        statusCode: 404,
      );

      await _tap(tester, find.byTooltip('Challenge Ada Lovelace'));
      await _tap(tester, find.text('Tic-Tac-Toe'));

      expect(
        find.text('That player is unavailable right now.'),
        findsOneWidget,
      );
    });

    testWidgets('shows a message when there are no games to challenge with', (
      tester,
    ) async {
      final opened = await _open(
        tester,
        seed: (h) => h.social.friends.add(buildFriend()),
      );
      opened.harness.games.gamesToReturn = [];

      await _tap(tester, find.byTooltip('Challenge Ada Lovelace'));

      expect(find.text('No games are available right now.'), findsOneWidget);
    });
  });

  group('removing and blocking a friend', () {
    Future<void> openMenu(WidgetTester tester, String item) async {
      await _tap(tester, find.byTooltip('More options for Ada Lovelace'));
      await _tap(tester, find.text(item));
    }

    testWidgets(
      'removing asks first, and the friend goes only after the server confirms',
      (tester) async {
        final opened = await _open(
          tester,
          seed: (h) => h.social.friends.add(buildFriend()),
        );

        await openMenu(tester, 'Remove friend');
        expect(find.text('Remove Ada Lovelace?'), findsOneWidget);
        await _tap(tester, find.text('Remove'));

        expect(
          find.text('Ada Lovelace removed from your friends.'),
          findsOneWidget,
        );
        expect(find.text('@ada_l'), findsNothing);
        expect(opened.social.callsTo('remove'), 1);
      },
    );

    testWidgets('cancelling the confirmation removes nobody', (tester) async {
      final opened = await _open(
        tester,
        seed: (h) => h.social.friends.add(buildFriend()),
      );

      await openMenu(tester, 'Remove friend');
      await _tap(tester, find.text('Cancel'));

      expect(opened.social.callsTo('remove'), 0);
      expect(find.text('@ada_l'), findsOneWidget);
    });

    testWidgets('a failed removal keeps the friend and shows why', (
      tester,
    ) async {
      await _open(
        tester,
        seed: (h) {
          h.social.friends.add(buildFriend());
          h.social.errors['remove'] = const NetworkException(
            'Friend not found',
            statusCode: 404,
          );
        },
      );

      await openMenu(tester, 'Remove friend');
      await _tap(tester, find.text('Remove'));

      expect(find.text('Friend not found'), findsOneWidget);
      expect(find.text('@ada_l'), findsOneWidget);
    });

    testWidgets(
      'blocking asks first, removes the friend, and lists the block',
      (tester) async {
        final opened = await _open(
          tester,
          seed: (h) => h.social.friends.add(buildFriend()),
        );

        await openMenu(tester, 'Block');
        expect(find.text('Block Ada Lovelace?'), findsOneWidget);
        await _tap(tester, find.text('Block'));

        expect(find.text('Ada Lovelace is blocked.'), findsOneWidget);
        expect(find.text('@ada_l'), findsNothing);
        expect(opened.social.callsTo('block'), 1);

        await _openTab(tester, 'Blocked');
        expect(find.text('@ada_l'), findsOneWidget);
        expect(find.text('Unblock'), findsOneWidget);
      },
    );

    testWidgets('a failed block changes nothing', (tester) async {
      await _open(
        tester,
        seed: (h) {
          h.social.friends.add(buildFriend());
          h.social.errors['block'] = const NetworkException(
            'boom',
            statusCode: 500,
          );
        },
      );

      await openMenu(tester, 'Block');
      await _tap(tester, find.text('Block'));

      expect(
        find.text('Something went wrong on our side. Please try again.'),
        findsOneWidget,
      );
      expect(find.text('@ada_l'), findsOneWidget);
    });
  });

  group('Requests tab', () {
    testWidgets('shows incoming and sent requests, and their empty states', (
      tester,
    ) async {
      await _open(tester);
      await _openTab(tester, 'Requests');

      expect(find.text('Incoming'), findsOneWidget);
      expect(find.text('Sent'), findsOneWidget);
      expect(find.text('No incoming friend requests.'), findsOneWidget);
      expect(find.text('You have no pending sent requests.'), findsOneWidget);
    });

    testWidgets('lists both kinds', (tester) async {
      await _open(
        tester,
        seed: (h) {
          h.social.incoming.add(buildRequest(id: 'in-1'));
          h.social.outgoing.add(
            buildRequest(
              id: 'out-1',
              direction: FriendRequestDirection.outgoing,
              playerId: _grace.id,
              username: 'grace_h',
              displayName: 'Grace Hopper',
            ),
          );
        },
      );
      await _openTab(tester, 'Requests');

      expect(find.text('Ada Lovelace'), findsOneWidget);
      expect(find.text('Wants to be your friend'), findsOneWidget);
      expect(find.text('Grace Hopper'), findsOneWidget);
      expect(find.text('Request sent'), findsOneWidget);
    });

    testWidgets('accepting makes them a friend, from the server response', (
      tester,
    ) async {
      final opened = await _open(
        tester,
        seed: (h) => h.social.incoming.add(buildRequest(id: 'in-1')),
      );
      await _openTab(tester, 'Requests');

      await _tap(tester, find.text('Accept'));

      expect(
        find.text('You and Ada Lovelace are now friends.'),
        findsOneWidget,
      );
      expect(find.text('Wants to be your friend'), findsNothing);
      expect(opened.social.callsTo('accept'), 1);

      await _openTab(tester, 'Friends');
      expect(find.text('Ada Lovelace'), findsOneWidget);
    });

    testWidgets('declining removes the request and makes no friend', (
      tester,
    ) async {
      await _open(
        tester,
        seed: (h) => h.social.incoming.add(buildRequest(id: 'in-1')),
      );
      await _openTab(tester, 'Requests');

      await _tap(tester, find.text('Decline'));

      expect(find.text('Request from Ada Lovelace declined.'), findsOneWidget);
      expect(find.text('Wants to be your friend'), findsNothing);
      await _openTab(tester, 'Friends');
      expect(find.text('Ada Lovelace'), findsNothing);
    });

    testWidgets('cancelling a sent request removes it', (tester) async {
      await _open(
        tester,
        seed: (h) => h.social.outgoing.add(
          buildRequest(id: 'out-1', direction: FriendRequestDirection.outgoing),
        ),
      );
      await _openTab(tester, 'Requests');

      await _tap(tester, find.text('Cancel'));

      expect(find.text('Request to Ada Lovelace cancelled.'), findsOneWidget);
      expect(find.text('Request sent'), findsNothing);
    });

    testWidgets(
      'a request that is already gone shows the reason and disappears',
      (tester) async {
        final opened = await _open(
          tester,
          seed: (h) => h.social.incoming.add(buildRequest(id: 'in-1')),
        );
        await _openTab(tester, 'Requests');
        opened.social.incoming.clear(); // resolved elsewhere

        await _tap(tester, find.text('Accept'));

        expect(
          find.text('This friend request is no longer pending'),
          findsOneWidget,
        );
        expect(find.text('Wants to be your friend'), findsNothing);
      },
    );

    testWidgets('tapping Accept again while it is in flight does nothing', (
      tester,
    ) async {
      final gate = Completer<void>();
      final opened = await _open(
        tester,
        seed: (h) {
          h.social.incoming.add(buildRequest(id: 'in-1'));
          h.social.gates['accept'] = gate;
        },
      );
      await _openTab(tester, 'Requests');

      await tester.tap(find.text('Accept'));
      await tester.pump();
      // The buttons are disabled while it runs; a further tap is a no-op.
      await tester.tap(find.text('Accept'), warnIfMissed: false);
      await tester.tap(find.text('Decline'), warnIfMissed: false);
      await tester.pump();

      expect(opened.social.callsTo('accept'), 1);
      expect(opened.social.callsTo('decline'), 0);

      gate.complete();
      await tester.pumpAndSettle();
      expect(opened.social.callsTo('accept'), 1);
    });

    testWidgets(
      'a pushed request appears after the list is re-fetched from the server',
      (tester) async {
        final opened = await _open(tester);
        await _openTab(tester, 'Requests');
        expect(find.text('Wants to be your friend'), findsNothing);

        opened.social.incoming.add(buildRequest(id: 'in-9'));
        opened.harness.ws.pushEvent('friend:request-received', {
          'requestId': 'in-9',
        });
        await tester.pumpAndSettle();

        expect(find.text('Wants to be your friend'), findsOneWidget);
      },
    );

    testWidgets('an event the server does not back up shows nothing', (
      tester,
    ) async {
      final opened = await _open(tester);
      await _openTab(tester, 'Requests');

      opened.harness.ws.pushEvent('friend:request-received', {
        'requestId': 'ghost',
      });
      await tester.pumpAndSettle();

      expect(find.text('Wants to be your friend'), findsNothing);
    });

    testWidgets('a pushed acceptance adds the friend after a re-fetch', (
      tester,
    ) async {
      final opened = await _open(
        tester,
        seed: (h) => h.social.outgoing.add(
          buildRequest(id: 'out-1', direction: FriendRequestDirection.outgoing),
        ),
      );
      opened.social.outgoing.clear();
      opened.social.friends.add(buildFriend());

      opened.harness.ws.pushEvent('friend:request-accepted', {
        'requestId': 'out-1',
      });
      await tester.pumpAndSettle();

      expect(find.text('Ada Lovelace'), findsOneWidget);
    });
  });

  group('Blocked tab', () {
    testWidgets('explains blocking and shows an empty state', (tester) async {
      await _open(tester);
      await _openTab(tester, 'Blocked');

      expect(
        find.textContaining('Unblocking does not bring back'),
        findsOneWidget,
      );
      expect(find.text("You haven't blocked anyone."), findsOneWidget);
    });

    testWidgets('unblocking removes the block and restores nothing', (
      tester,
    ) async {
      final opened = await _open(
        tester,
        seed: (h) => h.social.blocks.add(buildBlocked()),
      );
      await _openTab(tester, 'Blocked');
      expect(find.text('Ada Lovelace'), findsOneWidget);

      await _tap(tester, find.text('Unblock'));

      expect(
        find.textContaining('Friendships and requests are not restored.'),
        findsOneWidget,
      );
      expect(find.text('Unblock'), findsNothing);
      expect(opened.social.callsTo('unblock'), 1);

      await _openTab(tester, 'Friends');
      expect(find.text('Ada Lovelace'), findsNothing);
      await _openTab(tester, 'Requests');
      expect(find.text('Wants to be your friend'), findsNothing);
      expect(find.text('Request sent'), findsNothing);
    });

    testWidgets('a failed unblock keeps the block and shows why', (
      tester,
    ) async {
      await _open(
        tester,
        seed: (h) {
          h.social.blocks.add(buildBlocked());
          h.social.errors['unblock'] = const NetworkException('offline');
        },
      );
      await _openTab(tester, 'Blocked');

      await _tap(tester, find.text('Unblock'));

      expect(
        find.text(
          'Could not reach PlayLe. Check your connection and try again.',
        ),
        findsOneWidget,
      );
      expect(find.text('Unblock'), findsOneWidget);
    });

    testWidgets('an expired session offers to sign in again', (tester) async {
      await _open(
        tester,
        seed: (h) => h.social.errors['blocks'] = const NetworkException(
          'Unauthorized',
          statusCode: 401,
        ),
      );
      await _openTab(tester, 'Blocked');

      expect(find.text('Sign in again'), findsOneWidget);
    });
  });

  group('Find a player', () {
    Future<void> search(WidgetTester tester, String username) async {
      await tester.tap(find.byTooltip('Find a player'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), username);
      await tester.tap(find.widgetWithText(FilledButton, 'Search'));
      await tester.pumpAndSettle();
    }

    testWidgets('finds a player and sends a friend request', (tester) async {
      final opened = await _open(tester);

      await search(tester, 'ada_l');
      expect(find.text('@ada_l'), findsOneWidget);
      await tester.tap(find.text('Add friend'));
      await tester.pumpAndSettle();

      expect(find.text('Friend request sent to ada_l.'), findsOneWidget);
      expect(find.text('Find a player'), findsNothing); // the sheet closed
      expect(opened.social.callsTo('send'), 1);

      await _openTab(tester, 'Requests');
      expect(find.text('Request sent'), findsOneWidget);
    });

    testWidgets(
      'a username that does not exist, or has blocked you, is "no player found"',
      (tester) async {
        await _open(tester);

        await search(tester, 'nobody');

        expect(
          find.text('No player found with that username.'),
          findsOneWidget,
        );
        expect(find.text('Add friend'), findsNothing);
      },
    );

    testWidgets('searching for yourself is recognised', (tester) async {
      await _open(
        tester,
        seed: (h) => h.social.directory[myId] = const PlayerSummary(
          id: myId,
          username: 'playerone',
          displayName: null,
        ),
      );

      await search(tester, 'playerone');

      expect(find.text("That's you."), findsOneWidget);
    });

    testWidgets('a refused request shows the server reason', (tester) async {
      await _open(
        tester,
        seed: (h) => h.social.errors['send'] = const NetworkException(
          'You have blocked this player',
          statusCode: 409,
        ),
      );

      await search(tester, 'ada_l');
      await tester.tap(find.text('Add friend'));
      await tester.pumpAndSettle();

      expect(find.text('You have blocked this player'), findsOneWidget);
    });

    testWidgets('already friends: no second request is offered', (
      tester,
    ) async {
      await _open(tester, seed: (h) => h.social.friends.add(buildFriend()));

      await search(tester, 'ada_l');

      expect(find.text('Already friends'), findsOneWidget);
      expect(find.text('Add friend'), findsNothing);
    });

    testWidgets('a request already sent is shown as sent', (tester) async {
      await _open(
        tester,
        seed: (h) => h.social.outgoing.add(
          buildRequest(id: 'out-1', direction: FriendRequestDirection.outgoing),
        ),
      );

      await search(tester, 'ada_l');

      expect(find.text('Request sent'), findsOneWidget);
    });

    testWidgets('someone who already asked you can be accepted from here', (
      tester,
    ) async {
      final opened = await _open(
        tester,
        seed: (h) => h.social.incoming.add(buildRequest(id: 'in-1')),
      );

      await search(tester, 'ada_l');
      await tester.tap(find.text('Accept their request'));
      await tester.pumpAndSettle();

      expect(opened.social.callsTo('accept'), 1);
      expect(
        find.text('You and Ada Lovelace are now friends.'),
        findsOneWidget,
      );
    });

    testWidgets('a player you blocked offers Unblock, not Add friend', (
      tester,
    ) async {
      await _open(tester, seed: (h) => h.social.blocks.add(buildBlocked()));

      await search(tester, 'ada_l');

      expect(find.text('Unblock'), findsOneWidget);
      expect(find.text('Add friend'), findsNothing);
    });

    testWidgets('View profile closes the sheet and opens the profile', (
      tester,
    ) async {
      await _open(tester);

      await search(tester, 'ada_l');
      await tester.tap(find.text('View profile'));
      await tester.pumpAndSettle();

      expect(find.text('Player profile'), findsOneWidget);
      expect(find.text('Find a player'), findsNothing);
    });

    testWidgets('an empty search asks the server nothing', (tester) async {
      final opened = await _open(tester);

      await search(tester, '   ');

      expect(find.text('No player found with that username.'), findsOneWidget);
      expect(opened.social.callsTo('lookup'), 0);
    });

    testWidgets('an expired session during a search offers to sign in again', (
      tester,
    ) async {
      final opened = await _open(
        tester,
        seed: (h) => h.social.errors['lookup'] = const NetworkException(
          'Unauthorized',
          statusCode: 401,
        ),
      );

      await search(tester, 'ada_l');
      expect(
        find.text('Your session has expired. Please sign in again.'),
        findsWidgets,
      );
      await tester.tap(find.text('Sign in again').last);
      await tester.pump();

      expect(opened.auth.repository.loggedOut, isTrue);
    });
  });

  group('lifecycle', () {
    testWidgets('leaving the screen removes the realtime listeners', (
      tester,
    ) async {
      final opened = await _open(tester);
      expect(opened.harness.ws.listenerCount('friend:request-received'), 1);
      expect(opened.harness.ws.listenerCount('friend:request-accepted'), 1);

      opened.router.go('/account');
      await tester.pumpAndSettle();

      expect(opened.harness.ws.listenerCount('friend:request-received'), 0);
      expect(opened.harness.ws.listenerCount('friend:request-accepted'), 0);
    });

    testWidgets('opening the screen twice never leaves duplicate listeners', (
      tester,
    ) async {
      final opened = await _open(tester, location: '/account');

      for (var i = 0; i < 3; i++) {
        unawaited(opened.router.push('/friends'));
        await tester.pumpAndSettle();
        opened.router.pop();
        await tester.pumpAndSettle();
      }

      expect(opened.harness.ws.listenerCount('friend:request-received'), 0);
      expect(opened.harness.ws.subscribeCalls, 6); // 2 events x 3 visits
    });
  });
}
