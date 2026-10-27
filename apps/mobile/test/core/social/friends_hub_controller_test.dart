import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/games/game_models.dart';
import 'package:playle_mobile/core/social/friends_hub_controller.dart';
import 'package:playle_mobile/core/social/paged_list_controller.dart';
import 'package:playle_mobile/core/social/social_models.dart';

import '../games/fake_games_repository.dart';
import 'fake_social_repository.dart';
import 'friends_harness.dart';

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
const _alan = PlayerSummary(
  id: thirdPlayerId,
  username: 'alan_t',
  displayName: null,
);

/// A harness whose "server" knows ada, grace and alan.
FriendsHarness _harness({int pageSize = 20}) {
  final harness = FriendsHarness(pageSize: pageSize);
  harness.social.directory
    ..[_ada.id] = _ada
    ..[_grace.id] = _grace
    ..[_alan.id] = _alan;
  return harness;
}

FriendsHubController _started(FriendsHarness harness) {
  final hub = harness.create(myId);
  addTearDown(hub.dispose);
  return hub;
}

List<T> _items<T>(PagedListController<T> list) =>
    (list.state as PagedListLoaded<T>).items;

SocialActionSuccess _success(SocialActionResult result) {
  expect(result, isA<SocialActionSuccess>());
  return result as SocialActionSuccess;
}

SocialActionFailure _failure(SocialActionResult result) {
  expect(result, isA<SocialActionFailure>());
  return result as SocialActionFailure;
}

void main() {
  group('loading the lists', () {
    test('start loads friends, incoming, sent and blocked once each', () async {
      final harness = _harness();
      harness.social.friends.add(buildFriend());
      harness.social.incoming.add(buildRequest(playerId: _grace.id));
      harness.social.outgoing.add(
        buildRequest(
          id: 'out-1',
          direction: FriendRequestDirection.outgoing,
          playerId: _alan.id,
          username: 'alan_t',
          displayName: null,
        ),
      );
      harness.social.blocks.add(buildBlocked(userId: thirdPlayerId));
      final hub = _started(harness);

      await hub.start();

      expect(_items(hub.friends), hasLength(1));
      expect(_items(hub.incoming), hasLength(1));
      expect(_items(hub.outgoing), hasLength(1));
      expect(_items(hub.blocked), hasLength(1));
      for (final name in ['friends', 'incoming', 'outgoing', 'blocks']) {
        expect(harness.social.callsTo(name), 1, reason: name);
      }
    });

    test('empty lists are loaded and empty, not errors', () async {
      final hub = _started(_harness());

      await hub.start();

      expect(_items(hub.friends), isEmpty);
      expect(_items(hub.incoming), isEmpty);
      expect(_items(hub.outgoing), isEmpty);
      expect(_items(hub.blocked), isEmpty);
    });

    test('starting twice does not load twice', () async {
      final harness = _harness();
      final hub = _started(harness);

      await hub.start();
      await hub.start();

      expect(harness.social.callsTo('friends'), 1);
      expect(harness.realtime.connectCalls, 1);
    });

    test(
      'one list failing does not take the others down; retry recovers it',
      () async {
        final harness = _harness();
        harness.social.errors['friends'] = const NetworkException('offline');
        harness.social.incoming.add(buildRequest());
        final hub = _started(harness);

        await hub.start();

        expect(hub.friends.state, isA<PagedListError<FriendInfo>>());
        expect(
          (hub.friends.state as PagedListError<FriendInfo>).message,
          'Could not reach PlayLe. Check your connection and try again.',
        );
        expect(_items(hub.incoming), hasLength(1));

        harness.social.errors.remove('friends');
        await hub.friends.load();
        expect(hub.friends.state, isA<PagedListLoaded<FriendInfo>>());
      },
    );

    test('a 401 on a list is "unauthorized", not a retryable error', () async {
      final harness = _harness();
      harness.social.errors['blocks'] = const NetworkException(
        'Unauthorized',
        statusCode: 401,
      );
      final hub = _started(harness);

      await hub.start();

      expect(hub.blocked.state, isA<PagedListUnauthorized<BlockedPlayer>>());
    });

    test(
      'pages through a long list by cursor, appending and then stopping',
      () async {
        final harness = _harness(pageSize: 2);
        harness.social.friends.addAll([
          buildFriend(userId: 'f1', username: 'one'),
          buildFriend(userId: 'f2', username: 'two'),
          buildFriend(userId: 'f3', username: 'three'),
        ]);
        final hub = _started(harness);
        await hub.start();
        var state = hub.friends.state as PagedListLoaded<FriendInfo>;
        expect(state.items.map((f) => f.userId), ['f1', 'f2']);
        expect(state.hasMore, isTrue);

        await hub.friends.loadMore();

        state = hub.friends.state as PagedListLoaded<FriendInfo>;
        expect(state.items.map((f) => f.userId), ['f1', 'f2', 'f3']);
        expect(state.hasMore, isFalse);
        expect(harness.social.friendCursors, [null, 'f2']);

        await hub.friends.loadMore(); // nothing left
        expect(harness.social.callsTo('friends'), 2);
      },
    );

    test('a failed next page keeps the list and can be retried', () async {
      final harness = _harness(pageSize: 1);
      harness.social.friends.addAll([
        buildFriend(userId: 'f1', username: 'one'),
        buildFriend(userId: 'f2', username: 'two'),
      ]);
      final hub = _started(harness);
      await hub.start();

      harness.social.errors['friends'] = const NetworkException('offline');
      await hub.friends.loadMore();
      var state = hub.friends.state as PagedListLoaded<FriendInfo>;
      expect(state.items, hasLength(1));
      expect(state.loadMoreError, isNotNull);

      harness.social.errors.remove('friends');
      await hub.friends.loadMore();
      state = hub.friends.state as PagedListLoaded<FriendInfo>;
      expect(state.items, hasLength(2));
      expect(state.loadMoreError, isNull);
    });

    test('does not request the same next page twice at once', () async {
      final harness = _harness(pageSize: 1);
      harness.social.friends.addAll([
        buildFriend(userId: 'f1', username: 'one'),
        buildFriend(userId: 'f2', username: 'two'),
      ]);
      final hub = _started(harness);
      await hub.start();

      await Future.wait([hub.friends.loadMore(), hub.friends.loadMore()]);

      expect(harness.social.callsTo('friends'), 2); // first page + ONE more
    });

    test('a quiet reload that fails keeps what is on screen', () async {
      final harness = _harness();
      harness.social.friends.add(buildFriend());
      final hub = _started(harness);
      await hub.start();

      harness.social.errors['friends'] = const NetworkException('offline');
      await hub.friends.reload();

      expect(_items(hub.friends), hasLength(1));
    });

    test('a reload asked for mid-reload is run again afterwards', () async {
      final harness = _harness();
      final hub = _started(harness);
      await hub.start();
      final gate = Completer<void>();
      harness.social.gates['friends'] = gate;

      final first = hub.friends.reload();
      final second = hub.friends.reload(); // arrives while the first is running
      harness.social.friends.add(buildFriend()); // changes before it finishes
      harness.social.gates.remove('friends');
      gate.complete();
      await Future.wait([first, second]);

      expect(_items(hub.friends), hasLength(1));
    });
  });

  group('friend requests', () {
    test(
      'sending a request is confirmed by the server, then the sent list shows it',
      () async {
        final harness = _harness();
        final hub = _started(harness);
        await hub.start();

        final result = await hub.sendFriendRequest(_ada.id, 'Ada Lovelace');

        expect(
          _success(result).message,
          'Friend request sent to Ada Lovelace.',
        );
        expect(harness.social.callsTo('send'), 1);
        expect(_items(hub.outgoing).single.player.id, _ada.id);
        expect(_items(hub.friends), isEmpty);
      },
    );

    test(
      'sending to someone who already asked you makes you friends (crossed)',
      () async {
        final harness = _harness();
        harness.social.incoming.add(buildRequest(id: 'theirs'));
        final hub = _started(harness);
        await hub.start();

        final result = await hub.sendFriendRequest(_ada.id, 'Ada Lovelace');

        expect(
          _success(result).message,
          'You and Ada Lovelace are now friends.',
        );
        expect(_items(hub.friends).single.userId, _ada.id);
        expect(_items(hub.incoming), isEmpty);
      },
    );

    test(
      'a refused request shows the server reason and changes nothing',
      () async {
        final harness = _harness();
        harness.social.errors['send'] = const NetworkException(
          'You have blocked this player',
          statusCode: 409,
        );
        final hub = _started(harness);
        await hub.start();

        final result = await hub.sendFriendRequest(_ada.id, 'Ada Lovelace');

        final failure = _failure(result);
        expect(failure.message, 'You have blocked this player');
        expect(failure.sessionExpired, isFalse);
        expect(_items(hub.outgoing), isEmpty);
        expect(_items(hub.friends), isEmpty);
      },
    );

    test('a 401 is reported as an expired session', () async {
      final harness = _harness();
      harness.social.errors['send'] = const NetworkException(
        'Unauthorized',
        statusCode: 401,
      );
      final hub = _started(harness);
      await hub.start();

      final failure = _failure(await hub.sendFriendRequest(_ada.id, 'Ada'));

      expect(failure.sessionExpired, isTrue);
    });

    test('a second tap while the first is in flight is ignored', () async {
      final harness = _harness();
      final hub = _started(harness);
      await hub.start();
      final gate = Completer<void>();
      harness.social.gates['send'] = gate;

      final first = hub.sendFriendRequest(_ada.id, 'Ada');
      expect(hub.isPlayerBusy(_ada.id), isTrue);
      final second = await hub.sendFriendRequest(_ada.id, 'Ada');
      gate.complete();
      final firstResult = await first;

      expect(second, isA<SocialActionBusy>());
      expect(firstResult, isA<SocialActionSuccess>());
      expect(harness.social.callsTo('send'), 1);
      expect(hub.isPlayerBusy(_ada.id), isFalse);
    });

    test(
      'accepting moves the request into friends, from the server response',
      () async {
        final harness = _harness();
        harness.social.incoming.add(buildRequest(id: 'in-1'));
        final hub = _started(harness);
        await hub.start();

        final result = await hub.acceptRequest(_items(hub.incoming).single);

        expect(
          _success(result).message,
          'You and Ada Lovelace are now friends.',
        );
        expect(_items(hub.incoming), isEmpty);
        expect(_items(hub.friends).single.userId, opponentId);
      },
    );

    test('accept and decline on the same request cannot both run', () async {
      final harness = _harness();
      harness.social.incoming.add(buildRequest(id: 'in-1'));
      final hub = _started(harness);
      await hub.start();
      final request = _items(hub.incoming).single;
      final gate = Completer<void>();
      harness.social.gates['accept'] = gate;

      final accepting = hub.acceptRequest(request);
      expect(hub.isRequestBusy('in-1'), isTrue);
      final declining = await hub.declineRequest(request);
      gate.complete();
      await accepting;

      expect(declining, isA<SocialActionBusy>());
      expect(harness.social.callsTo('decline'), 0);
      expect(hub.isRequestBusy('in-1'), isFalse);
    });

    test(
      'a stale accept fails with the server reason and the list is reconciled',
      () async {
        final harness = _harness();
        harness.social.incoming.add(buildRequest(id: 'in-1'));
        final hub = _started(harness);
        await hub.start();
        final request = _items(hub.incoming).single;
        // It was cancelled on the other side before this tap reached the server.
        harness.social.incoming.clear();

        final result = await hub.acceptRequest(request);

        expect(
          _failure(result).message,
          'This friend request is no longer pending',
        );
        expect(_items(hub.incoming), isEmpty); // re-fetched, no longer shown
        expect(_items(hub.friends), isEmpty);
      },
    );

    test(
      'declining removes only that request and makes no friendship',
      () async {
        final harness = _harness();
        harness.social.incoming.addAll([
          buildRequest(id: 'in-1'),
          buildRequest(id: 'in-2', playerId: _grace.id, username: 'grace_h'),
        ]);
        final hub = _started(harness);
        await hub.start();

        final result = await hub.declineRequest(_items(hub.incoming).first);

        expect(_success(result).message, 'Request from Ada Lovelace declined.');
        expect(_items(hub.incoming).single.id, 'in-2');
        expect(_items(hub.friends), isEmpty);
      },
    );

    test('cancelling removes the sent request', () async {
      final harness = _harness();
      harness.social.outgoing.add(
        buildRequest(id: 'out-1', direction: FriendRequestDirection.outgoing),
      );
      final hub = _started(harness);
      await hub.start();

      final result = await hub.cancelRequest(_items(hub.outgoing).single);

      expect(_success(result).message, 'Request to Ada Lovelace cancelled.');
      expect(_items(hub.outgoing), isEmpty);
    });
  });

  group('friends', () {
    test(
      'removing a friend is confirmed by the server before it disappears',
      () async {
        final harness = _harness();
        harness.social.friends.addAll([
          buildFriend(),
          buildFriend(userId: _grace.id, username: 'grace_h'),
        ]);
        final hub = _started(harness);
        await hub.start();

        final result = await hub.removeFriend(_items(hub.friends).first);

        expect(
          _success(result).message,
          'Ada Lovelace removed from your friends.',
        );
        expect(_items(hub.friends).single.userId, _grace.id);
      },
    );

    test(
      'a failed removal leaves the friend in place with the server reason',
      () async {
        final harness = _harness();
        harness.social.friends.add(buildFriend());
        harness.social.errors['remove'] = const NetworkException(
          'Friend not found',
          statusCode: 404,
        );
        final hub = _started(harness);
        await hub.start();

        final result = await hub.removeFriend(_items(hub.friends).single);

        expect(_failure(result).message, 'Friend not found');
        expect(_items(hub.friends), hasLength(1));
      },
    );

    test('removing twice at once makes one request', () async {
      final harness = _harness();
      harness.social.friends.add(buildFriend());
      final hub = _started(harness);
      await hub.start();
      final friend = _items(hub.friends).single;
      final gate = Completer<void>();
      harness.social.gates['remove'] = gate;

      final first = hub.removeFriend(friend);
      final second = await hub.removeFriend(friend);
      gate.complete();
      await first;

      expect(second, isA<SocialActionBusy>());
      expect(harness.social.callsTo('remove'), 1);
    });
  });

  group('blocking', () {
    test(
      'blocking removes the friendship and cancels requests, then lists the block',
      () async {
        final harness = _harness();
        harness.social.friends.add(buildFriend());
        harness.social.incoming.add(buildRequest(id: 'in-1'));
        harness.social.outgoing.add(
          buildRequest(id: 'out-1', direction: FriendRequestDirection.outgoing),
        );
        final hub = _started(harness);
        await hub.start();

        final result = await hub.blockPlayer(_ada.id, 'Ada Lovelace');

        expect(_success(result).message, 'Ada Lovelace is blocked.');
        expect(_items(hub.blocked).single.userId, _ada.id);
        expect(_items(hub.friends), isEmpty);
        expect(_items(hub.incoming), isEmpty);
        expect(_items(hub.outgoing), isEmpty);
      },
    );

    test('a failed block changes nothing', () async {
      final harness = _harness();
      harness.social.friends.add(buildFriend());
      harness.social.errors['block'] = const NetworkException(
        'boom',
        statusCode: 500,
      );
      final hub = _started(harness);
      await hub.start();

      final result = await hub.blockPlayer(_ada.id, 'Ada Lovelace');

      expect(
        _failure(result).message,
        'Something went wrong on our side. Please try again.',
      );
      expect(_items(hub.blocked), isEmpty);
      expect(_items(hub.friends), hasLength(1));
    });

    test('unblocking restores neither the friendship nor the requests', () async {
      final harness = _harness();
      harness.social.friends.add(buildFriend());
      harness.social.incoming.add(buildRequest(id: 'in-1'));
      final hub = _started(harness);
      await hub.start();
      await hub.blockPlayer(_ada.id, 'Ada Lovelace');
      expect(_items(hub.friends), isEmpty);

      final result = await hub.unblockPlayer(_items(hub.blocked).single);

      expect(
        _success(result).message,
        'Ada Lovelace is unblocked. Friendships and requests are not restored.',
      );
      expect(_items(hub.blocked), isEmpty);
      // The server brought nothing back, and the app did not invent it.
      expect(_items(hub.friends), isEmpty);
      expect(_items(hub.incoming), isEmpty);
      expect(_items(hub.outgoing), isEmpty);
      // ...and the friends and requests lists were not even re-fetched.
      expect(harness.social.callsTo('friends'), 2); // start + the block
      expect(harness.social.callsTo('incoming'), 2);
    });

    test(
      'block and unblock cannot run twice at once for the same player',
      () async {
        final harness = _harness();
        final hub = _started(harness);
        await hub.start();
        final gate = Completer<void>();
        harness.social.gates['block'] = gate;

        final blocking = hub.blockPlayer(_ada.id, 'Ada');
        final again = await hub.blockPlayer(_ada.id, 'Ada');
        gate.complete();
        await blocking;

        expect(again, isA<SocialActionBusy>());
        expect(harness.social.callsTo('block'), 1);
      },
    );
  });

  group('finding a player', () {
    test(
      'finds a player by exact username, trimming spaces and a leading @',
      () async {
        final harness = _harness();
        final hub = _started(harness);

        final outcome = await hub.lookup('  @ada_l ');

        expect(outcome, isA<LookupFound>());
        expect((outcome as LookupFound).player.id, _ada.id);
        expect(harness.social.log, contains('lookup:ada_l'));
      },
    );

    test(
      'a username that does not exist - or has blocked you - is "not found"',
      () async {
        final hub = _started(_harness());

        expect(await hub.lookup('nobody'), isA<LookupNotFound>());
      },
    );

    test(
      'an empty username is "not found" without asking the server',
      () async {
        final harness = _harness();
        final hub = _started(harness);

        expect(await hub.lookup('   '), isA<LookupNotFound>());
        expect(await hub.lookup('@'), isA<LookupNotFound>());
        expect(harness.social.callsTo('lookup'), 0);
      },
    );

    test('finding yourself is recognised', () async {
      final harness = _harness();
      harness.social.directory[myId] = const PlayerSummary(
        id: myId,
        username: 'playerone',
        displayName: null,
      );
      final hub = _started(harness);

      expect(await hub.lookup('playerone'), isA<LookupIsSelf>());
    });

    test('failures: expired session and a server error', () async {
      final harness = _harness();
      final hub = _started(harness);

      harness.social.errors['lookup'] = const NetworkException(
        'Unauthorized',
        statusCode: 401,
      );
      final expired = await hub.lookup('ada_l');
      expect(expired, isA<LookupFailed>());
      expect((expired as LookupFailed).sessionExpired, isTrue);

      harness.social.errors['lookup'] = const NetworkException(
        'x',
        statusCode: 503,
      );
      final down = await hub.lookup('ada_l') as LookupFailed;
      expect(down.sessionExpired, isFalse);
      expect(
        down.message,
        'Something went wrong on our side. Please try again.',
      );
    });

    test('searching again while a search is running is ignored', () async {
      final harness = _harness();
      final hub = _started(harness);
      final gate = Completer<void>();
      harness.social.gates['lookup'] = gate;

      final first = hub.lookup('ada_l');
      expect(hub.isLookingUp, isTrue);
      final second = await hub.lookup('ada_l');
      gate.complete();
      await first;

      expect(second, isA<LookupBusy>());
      expect(harness.social.callsTo('lookup'), 1);
    });

    test('relationTo reflects the loaded lists', () async {
      final harness = _harness();
      harness.social.friends.add(buildFriend());
      harness.social.incoming.add(
        buildRequest(id: 'in-1', playerId: _grace.id, username: 'grace_h'),
      );
      harness.social.outgoing.add(
        buildRequest(
          id: 'out-1',
          direction: FriendRequestDirection.outgoing,
          playerId: _alan.id,
        ),
      );
      harness.social.blocks.add(buildBlocked(userId: 'blocked-1'));
      final hub = _started(harness);
      await hub.start();

      expect(hub.relationTo(opponentId), PlayerRelation.friend);
      expect(hub.relationTo(_grace.id), PlayerRelation.requestReceived);
      expect(hub.relationTo(_alan.id), PlayerRelation.requestSent);
      expect(hub.relationTo('blocked-1'), PlayerRelation.blocked);
      expect(hub.relationTo('someone-else'), PlayerRelation.none);
    });
  });

  group('challenging a friend', () {
    final game = testGame;

    test('loads the games once and reuses them', () async {
      final harness = _harness();
      final hub = _started(harness);

      final first = await hub.loadGames();
      final second = await hub.loadGames();

      expect(first.games.single.id, game.id);
      expect(second.games.single.id, game.id);
    });

    test(
      'a games failure is reported, and a 401 as an expired session',
      () async {
        final games = _ScriptedGames()
          ..error = const NetworkException('offline');
        final harness = FriendsHarness(games: games);
        final hub = _started(harness);

        final down = await hub.loadGames();
        expect(down.error, isNotNull);
        expect(down.sessionExpired, isFalse);

        games.error = const NetworkException('Unauthorized', statusCode: 401);
        final expired = await hub.loadGames();
        expect(expired.sessionExpired, isTrue);
      },
    );

    test(
      'creates a free-play challenge through the existing flow, for that friend and game',
      () async {
        final harness = _harness();
        harness.social.friends.add(buildFriend());
        final hub = _started(harness);
        await hub.start();

        final result = await hub.challengeFriend(
          _items(hub.friends).single,
          game,
        );

        expect(
          _success(result).message,
          startsWith('Challenge sent to Ada Lovelace'),
        );
        expect(harness.challenges, [(gameId: game.id, opponentId: opponentId)]);
      },
    );

    test(
      'the server\'s reason is shown when it refuses (blocked, already playing, duplicate)',
      () async {
        final harness = _harness();
        harness.social.friends.add(buildFriend());
        final hub = _started(harness);
        await hub.start();
        final friend = _items(hub.friends).single;

        for (final reason in [
          'You have blocked this player',
          'You are already in an active or pending match',
          'There is already a pending challenge between you and this player for this game',
        ]) {
          harness.challengeError = NetworkException(reason, statusCode: 409);
          final result = await hub.challengeFriend(friend, game);
          expect(_failure(result).message, reason);
        }
      },
    );

    test('an unavailable player is reported plainly', () async {
      final harness = _harness();
      harness.social.friends.add(buildFriend());
      harness.challengeError = const NetworkException(
        'Opponent not found',
        statusCode: 404,
      );
      final hub = _started(harness);
      await hub.start();

      final result = await hub.challengeFriend(
        _items(hub.friends).single,
        game,
      );

      expect(_failure(result).message, 'That player is unavailable right now.');
    });

    test('an expired session while challenging is flagged', () async {
      final harness = _harness();
      harness.social.friends.add(buildFriend());
      harness.challengeError = const NetworkException(
        'Unauthorized',
        statusCode: 401,
      );
      final hub = _started(harness);
      await hub.start();

      final result = await hub.challengeFriend(
        _items(hub.friends).single,
        game,
      );

      expect(_failure(result).sessionExpired, isTrue);
    });

    test('a second tap while the challenge is being sent is ignored', () async {
      final harness = _harness();
      harness.social.friends.add(buildFriend());
      final hub = _started(harness);
      await hub.start();
      final friend = _items(hub.friends).single;
      final gate = Completer<void>();
      harness.challengeGate = gate;

      final first = hub.challengeFriend(friend, game);
      final second = await hub.challengeFriend(friend, game);
      gate.complete();
      await first;

      expect(second, isA<SocialActionBusy>());
      expect(harness.challenges, hasLength(1));
    });

    test(
      'a blocked player is not on the friends list, so cannot be challenged from it',
      () async {
        final harness = _harness();
        harness.social.friends.add(buildFriend());
        final hub = _started(harness);
        await hub.start();
        await hub.blockPlayer(opponentId, 'Ada Lovelace');

        expect(_items(hub.friends), isEmpty);
        expect(hub.relationTo(opponentId), PlayerRelation.blocked);
      },
    );
  });

  group('realtime', () {
    test(
      'subscribes once to the two friend events, after connecting',
      () async {
        final harness = _harness();
        final hub = _started(harness);

        await hub.start();
        await hub.start();

        expect(harness.realtime.connectCalls, 1);
        expect(harness.ws.listenerCount('friend:request-received'), 1);
        expect(harness.ws.listenerCount('friend:request-accepted'), 1);
        expect(harness.ws.subscribeCalls, 2);
      },
    );

    test(
      'a received request is only a hint: the list is re-fetched from the server',
      () async {
        final harness = _harness();
        final hub = _started(harness);
        await hub.start();
        expect(_items(hub.incoming), isEmpty);
        harness.social.incoming.add(buildRequest(id: 'in-9'));

        harness.ws.pushEvent('friend:request-received', {
          'requestId': 'in-9',
          'from': {'id': opponentId, 'username': 'ada_l', 'displayName': null},
        });
        await Future<void>.delayed(Duration.zero);
        await Future<void>.delayed(Duration.zero);

        expect(harness.social.callsTo('incoming'), 2);
        expect(_items(hub.incoming).single.id, 'in-9');
      },
    );

    test('an event that the server does not back up changes nothing', () async {
      final harness = _harness();
      final hub = _started(harness);
      await hub.start();

      // The event claims a request exists; the server has none.
      harness.ws.pushEvent('friend:request-received', {'requestId': 'ghost'});
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(_items(hub.incoming), isEmpty);
    });

    test(
      'an accepted request re-fetches the sent requests and the friends',
      () async {
        final harness = _harness();
        harness.social.outgoing.add(
          buildRequest(id: 'out-1', direction: FriendRequestDirection.outgoing),
        );
        final hub = _started(harness);
        await hub.start();
        // The other side accepted: the server now has a friendship, no request.
        harness.social.outgoing.clear();
        harness.social.friends.add(buildFriend());

        harness.ws.pushEvent('friend:request-accepted', {
          'requestId': 'out-1',
          'friend': {
            'id': opponentId,
            'username': 'ada_l',
            'displayName': null,
          },
        });
        await Future<void>.delayed(Duration.zero);
        await Future<void>.delayed(Duration.zero);

        expect(_items(hub.outgoing), isEmpty);
        expect(_items(hub.friends).single.userId, opponentId);
      },
    );

    test(
      'dispose removes the listeners, and later events do nothing',
      () async {
        final harness = _harness();
        final hub = harness.create(myId);
        await hub.start();
        final callsBefore = harness.social.callsTo('incoming');

        hub.dispose();
        harness.ws.pushEvent('friend:request-received', {'requestId': 'x'});
        await Future<void>.delayed(Duration.zero);

        expect(harness.ws.listenerCount('friend:request-received'), 0);
        expect(harness.ws.listenerCount('friend:request-accepted'), 0);
        expect(harness.social.callsTo('incoming'), callsBefore);
      },
    );

    test('disposing before start finishes does not subscribe at all', () async {
      final harness = _harness();
      final gate = Completer<void>();
      harness.social.gates['friends'] = gate;
      final hub = harness.create(myId);

      final starting = hub.start();
      hub.dispose();
      gate.complete();
      await starting;

      expect(harness.ws.listenerCount('friend:request-received'), 0);
      expect(harness.realtime.connectCalls, 0);
    });

    test('an action that finishes after dispose does not throw', () async {
      final harness = _harness();
      final hub = harness.create(myId);
      await hub.start();
      final gate = Completer<void>();
      harness.social.gates['send'] = gate;

      final sending = hub.sendFriendRequest(_ada.id, 'Ada');
      hub.dispose();
      gate.complete();

      expect(await sending, isA<SocialActionSuccess>());
    });
  });
}

class _ScriptedGames extends FakeGamesRepository {
  Object? error;

  @override
  Future<List<GameInfo>> listGames() async {
    final e = error;
    if (e != null) {
      throw e;
    }
    return gamesToReturn;
  }
}
