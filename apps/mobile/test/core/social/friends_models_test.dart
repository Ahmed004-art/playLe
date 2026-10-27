import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/social/social_models.dart';

import 'fake_social_repository.dart';

Map<String, dynamic> _friendJson({Map<String, dynamic>? overrides}) => {
  'userId': opponentId,
  'username': 'ada_l',
  'displayName': 'Ada Lovelace',
  'presence': 'ONLINE',
  'friendsSince': '2026-10-01T12:00:00.000Z',
  ...?overrides,
};

Map<String, dynamic> _requestJson({Map<String, dynamic>? overrides}) => {
  'id': 'request-1',
  'status': 'PENDING',
  'direction': 'INCOMING',
  'player': {'id': opponentId, 'username': 'ada_l', 'displayName': null},
  'createdAt': '2026-10-02T12:00:00.000Z',
  'respondedAt': null,
  ...?overrides,
};

void main() {
  group('FriendInfo.fromJson', () {
    test('parses a friend and their presence', () {
      final friend = FriendInfo.fromJson(_friendJson());

      expect(friend.userId, opponentId);
      expect(friend.username, 'ada_l');
      expect(friend.displayLabel, 'Ada Lovelace');
      expect(friend.presence, FriendPresence.online);
      expect(friend.friendsSince, DateTime.utc(2026, 10, 1, 12));
    });

    test('maps every presence the API can send', () {
      expect(FriendPresence.parse('ONLINE'), FriendPresence.online);
      expect(FriendPresence.parse('IN_MATCH'), FriendPresence.inMatch);
      expect(FriendPresence.parse('SEARCHING'), FriendPresence.searching);
      expect(FriendPresence.parse('OFFLINE'), FriendPresence.offline);
    });

    test('an unknown or missing presence is offline, never online', () {
      expect(FriendPresence.parse('SOMETHING_NEW'), FriendPresence.offline);
      expect(FriendPresence.parse(null), FriendPresence.offline);
      final friend = FriendInfo.fromJson(
        _friendJson(overrides: {'presence': 5}),
      );
      expect(friend.presence, FriendPresence.offline);
    });

    test('has readable labels', () {
      expect(FriendPresence.online.label, 'Online');
      expect(FriendPresence.inMatch.label, 'In a match');
      expect(FriendPresence.searching.label, 'Looking for a match');
      expect(FriendPresence.offline.label, 'Offline');
    });

    test('falls back to the username without a display name', () {
      final friend = FriendInfo.fromJson(
        _friendJson(overrides: {'displayName': null}),
      );

      expect(friend.displayLabel, 'ada_l');
    });

    test('ignores anything outside the contract', () {
      final friend = FriendInfo.fromJson(
        _friendJson(overrides: {'email': 'ada@example.com', 'wallet': '9'}),
      );

      expect(friend.userId, opponentId);
    });

    test('rejects a missing id, username or date', () {
      for (final key in ['userId', 'username', 'friendsSince']) {
        final json = _friendJson()..remove(key);
        expect(() => FriendInfo.fromJson(json), throwsFormatException);
      }
    });
  });

  group('FriendRequestInfo.fromJson', () {
    test('parses an incoming request with the other player', () {
      final request = FriendRequestInfo.fromJson(_requestJson());

      expect(request.id, 'request-1');
      expect(request.status, 'PENDING');
      expect(request.isPending, isTrue);
      expect(request.isAccepted, isFalse);
      expect(request.direction, FriendRequestDirection.incoming);
      expect(request.player.id, opponentId);
      expect(request.player.displayLabel, 'ada_l');
      expect(request.createdAt, DateTime.utc(2026, 10, 2, 12));
      expect(request.respondedAt, isNull);
    });

    test('parses an outgoing, accepted request', () {
      final request = FriendRequestInfo.fromJson(
        _requestJson(
          overrides: {
            'direction': 'OUTGOING',
            'status': 'ACCEPTED',
            'respondedAt': '2026-10-03T12:00:00.000Z',
          },
        ),
      );

      expect(request.direction, FriendRequestDirection.outgoing);
      expect(request.isAccepted, isTrue);
      expect(request.respondedAt, DateTime.utc(2026, 10, 3, 12));
    });

    test('rejects an unknown direction, a missing player and a bad date', () {
      expect(
        () => FriendRequestInfo.fromJson(
          _requestJson(overrides: {'direction': 'SIDEWAYS'}),
        ),
        throwsFormatException,
      );
      expect(
        () => FriendRequestInfo.fromJson(_requestJson()..remove('player')),
        throwsFormatException,
      );
      expect(
        () => FriendRequestInfo.fromJson(
          _requestJson(overrides: {'createdAt': 'yesterday'}),
        ),
        throwsFormatException,
      );
    });

    test('the direction query values match the API', () {
      expect(FriendRequestDirection.incoming.apiValue, 'incoming');
      expect(FriendRequestDirection.outgoing.apiValue, 'outgoing');
    });
  });

  group('BlockedPlayer and PlayerLookupResult', () {
    test('parse a blocked player', () {
      final blocked = BlockedPlayer.fromJson({
        'userId': opponentId,
        'username': 'ada_l',
        'displayName': null,
        'blockedAt': '2026-10-03T12:00:00.000Z',
      });

      expect(blocked.userId, opponentId);
      expect(blocked.displayLabel, 'ada_l');
      expect(blocked.blockedAt, DateTime.utc(2026, 10, 3, 12));
    });

    test('a blocked player needs a date', () {
      expect(
        () => BlockedPlayer.fromJson({
          'userId': opponentId,
          'username': 'ada_l',
          'displayName': null,
        }),
        throwsFormatException,
      );
    });

    test('parse a lookup result and require both fields', () {
      final found = PlayerLookupResult.fromJson({
        'id': opponentId,
        'username': 'ada_l',
      });

      expect(found.id, opponentId);
      expect(found.username, 'ada_l');
      expect(
        () => PlayerLookupResult.fromJson({'id': opponentId}),
        throwsFormatException,
      );
    });
  });

  group('SocialPage.parse', () {
    test('parses items and the next cursor', () {
      final page = SocialPage.parse({
        'items': [
          _friendJson(),
          _friendJson(overrides: {'userId': 'f2'}),
        ],
        'nextCursor': 'f2',
      }, FriendInfo.fromJson);

      expect(page.items.map((f) => f.userId), [opponentId, 'f2']);
      expect(page.nextCursor, 'f2');
    });

    test('a null cursor is the last page; the items list is required', () {
      final last = SocialPage.parse({
        'items': [],
        'nextCursor': null,
      }, FriendInfo.fromJson);
      expect(last.items, isEmpty);
      expect(last.nextCursor, isNull);

      expect(
        () => SocialPage.parse({'nextCursor': null}, FriendInfo.fromJson),
        throwsFormatException,
      );
    });
  });
}
