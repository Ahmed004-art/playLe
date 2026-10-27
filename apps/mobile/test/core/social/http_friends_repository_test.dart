import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/config/app_config.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/network/api_client.dart';
import 'package:playle_mobile/core/social/social_models.dart';
import 'package:playle_mobile/core/social/social_repository.dart';

import 'fake_social_repository.dart';

/// Answers every request with whatever [handler] returns (or throws), and
/// records the requests, so the repository is tested through the real
/// [ApiClient] and Dio without any network.
class _StubAdapter implements HttpClientAdapter {
  _StubAdapter(this.handler);

  final ResponseBody Function(RequestOptions options) handler;
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    return handler(options);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody _json(Object body, {int status = 200}) {
  return ResponseBody.fromString(
    jsonEncode(body),
    status,
    headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    },
  );
}

ResponseBody _noContent() => ResponseBody.fromString('', 204);

HttpSocialRepository _repository(_StubAdapter adapter) {
  final dio = Dio(BaseOptions(baseUrl: 'http://test.invalid/api/v1'))
    ..httpClientAdapter = adapter;
  final client = ApiClient(
    config: const AppConfig(
      environment: Environment.development,
      apiBaseUrl: 'http://test.invalid/api/v1',
      socketUrl: 'http://test.invalid',
    ),
    dio: dio,
  );
  return HttpSocialRepository(apiClient: client);
}

Map<String, dynamic> _friend(String id) => {
  'userId': id,
  'username': 'ada_l',
  'displayName': null,
  'presence': 'OFFLINE',
  'friendsSince': '2026-10-01T12:00:00.000Z',
};

Map<String, dynamic> _request({String status = 'PENDING'}) => {
  'id': 'request-1',
  'status': status,
  'direction': 'OUTGOING',
  'player': {'id': opponentId, 'username': 'ada_l', 'displayName': null},
  'createdAt': '2026-10-02T12:00:00.000Z',
  'respondedAt': null,
};

Map<String, dynamic> _blocked() => {
  'userId': opponentId,
  'username': 'ada_l',
  'displayName': null,
  'blockedAt': '2026-10-03T12:00:00.000Z',
};

void main() {
  group('friends', () {
    test('GET /friends with the limit, then the cursor', () async {
      final adapter = _StubAdapter(
        (_) => _json({
          'items': [_friend('f1')],
          'nextCursor': 'f1',
        }),
      );
      final repository = _repository(adapter);

      final first = await repository.getFriends(limit: 10);
      await repository.getFriends(cursor: 'f1');

      expect(adapter.requests[0].method, 'GET');
      expect(adapter.requests[0].path, '/friends');
      expect(adapter.requests[0].queryParameters, {'limit': 10});
      expect(adapter.requests[1].queryParameters, {
        'limit': 20,
        'cursor': 'f1',
      });
      expect(first.items.single.userId, 'f1');
      expect(first.nextCursor, 'f1');
    });

    test('DELETE /friends/:userId accepts the empty 204', () async {
      final adapter = _StubAdapter((_) => _noContent());

      await _repository(adapter).removeFriend(opponentId);

      expect(adapter.requests.single.method, 'DELETE');
      expect(adapter.requests.single.path, '/friends/$opponentId');
    });

    test('a 404 on remove keeps its status', () async {
      final adapter = _StubAdapter(
        (_) => _json({
          'statusCode': 404,
          'message': 'Friend not found',
        }, status: 404),
      );

      await expectLater(
        _repository(adapter).removeFriend(opponentId),
        throwsA(
          isA<NetworkException>()
              .having((e) => e.statusCode, 'statusCode', 404)
              .having((e) => e.message, 'message', 'Friend not found'),
        ),
      );
    });
  });

  group('friend requests', () {
    test('lists each direction with the right query', () async {
      final adapter = _StubAdapter(
        (_) => _json({
          'items': [_request()],
          'nextCursor': null,
        }),
      );
      final repository = _repository(adapter);

      final incoming = await repository.getFriendRequests(
        FriendRequestDirection.incoming,
      );
      await repository.getFriendRequests(
        FriendRequestDirection.outgoing,
        cursor: 'r1',
        limit: 5,
      );

      expect(adapter.requests[0].path, '/friends/requests');
      expect(adapter.requests[0].queryParameters, {
        'direction': 'incoming',
        'limit': 20,
      });
      expect(adapter.requests[1].queryParameters, {
        'direction': 'outgoing',
        'limit': 5,
        'cursor': 'r1',
      });
      expect(incoming.items.single.id, 'request-1');
    });

    test(
      'POST /friends/requests sends the user id and parses the result',
      () async {
        final adapter = _StubAdapter((_) => _json(_request(), status: 201));

        final request = await _repository(
          adapter,
        ).sendFriendRequest(opponentId);

        expect(adapter.requests.single.method, 'POST');
        expect(adapter.requests.single.path, '/friends/requests');
        expect(adapter.requests.single.data, {'userId': opponentId});
        expect(request.isPending, isTrue);
      },
    );

    test('a crossed request comes back accepted', () async {
      final adapter = _StubAdapter(
        (_) => _json(_request(status: 'ACCEPTED'), status: 201),
      );

      final request = await _repository(adapter).sendFriendRequest(opponentId);

      expect(request.isAccepted, isTrue);
    });

    test(
      'accept, decline and cancel post to the right paths with no body',
      () async {
        final adapter = _StubAdapter((_) => _json(_request()));
        final repository = _repository(adapter);

        await repository.acceptFriendRequest('r1');
        await repository.declineFriendRequest('r2');
        await repository.cancelFriendRequest('r3');

        expect(adapter.requests.map((r) => r.method), ['POST', 'POST', 'POST']);
        expect(adapter.requests.map((r) => r.path), [
          '/friends/requests/r1/accept',
          '/friends/requests/r2/decline',
          '/friends/requests/r3/cancel',
        ]);
        expect(adapter.requests.every((r) => r.data == null), isTrue);
      },
    );

    test('a 409 keeps its status and the server reason', () async {
      final adapter = _StubAdapter(
        (_) => _json({
          'statusCode': 409,
          'message': 'You already have a pending friend request to this player',
        }, status: 409),
      );

      await expectLater(
        _repository(adapter).sendFriendRequest(opponentId),
        throwsA(
          isA<NetworkException>()
              .having((e) => e.statusCode, 'statusCode', 409)
              .having(
                (e) => e.message,
                'message',
                'You already have a pending friend request to this player',
              ),
        ),
      );
    });

    test('a 401 keeps its status', () async {
      final adapter = _StubAdapter(
        (_) =>
            _json({'statusCode': 401, 'message': 'Unauthorized'}, status: 401),
      );

      await expectLater(
        _repository(adapter).acceptFriendRequest('r1'),
        throwsA(
          isA<NetworkException>().having(
            (e) => e.statusCode,
            'statusCode',
            401,
          ),
        ),
      );
    });

    test(
      'a malformed request body is a NetworkException, not a crash',
      () async {
        final body = _request()..remove('player');
        final adapter = _StubAdapter((_) => _json(body));

        await expectLater(
          _repository(adapter).acceptFriendRequest('r1'),
          throwsA(isA<NetworkException>()),
        );
      },
    );
  });

  group('blocks', () {
    test('GET /blocks lists the blocked players', () async {
      final adapter = _StubAdapter(
        (_) => _json({
          'items': [_blocked()],
          'nextCursor': null,
        }),
      );

      final page = await _repository(adapter).getBlocks();

      expect(adapter.requests.single.path, '/blocks');
      expect(page.items.single.userId, opponentId);
    });

    test('POST /blocks sends the user id', () async {
      final adapter = _StubAdapter((_) => _json(_blocked()));

      final blocked = await _repository(adapter).blockPlayer(opponentId);

      expect(adapter.requests.single.method, 'POST');
      expect(adapter.requests.single.path, '/blocks');
      expect(adapter.requests.single.data, {'userId': opponentId});
      expect(blocked.userId, opponentId);
    });

    test('DELETE /blocks/:userId accepts the empty 204', () async {
      final adapter = _StubAdapter((_) => _noContent());

      await _repository(adapter).unblockPlayer(opponentId);

      expect(adapter.requests.single.method, 'DELETE');
      expect(adapter.requests.single.path, '/blocks/$opponentId');
    });
  });

  group('lookup', () {
    test('GET /users/lookup with the exact username', () async {
      final adapter = _StubAdapter(
        (_) => _json({'id': opponentId, 'username': 'ada_l'}),
      );

      final found = await _repository(adapter).lookupPlayer('ada_l');

      expect(adapter.requests.single.path, '/users/lookup');
      expect(adapter.requests.single.queryParameters, {'username': 'ada_l'});
      expect(found.id, opponentId);
    });

    test('a 404 (unknown, or has blocked you) keeps its status', () async {
      final adapter = _StubAdapter(
        (_) => _json({
          'statusCode': 404,
          'message': 'No account with that username',
        }, status: 404),
      );

      await expectLater(
        _repository(adapter).lookupPlayer('ghost'),
        throwsA(
          isA<NetworkException>().having(
            (e) => e.statusCode,
            'statusCode',
            404,
          ),
        ),
      );
    });
  });

  test(
    'the social endpoints never touch money, stakes or settlement',
    () async {
      final adapter = _StubAdapter((options) {
        if (options.method == 'DELETE') {
          return _noContent();
        }
        if (options.path == '/users/lookup') {
          return _json({'id': opponentId, 'username': 'ada_l'});
        }
        if (options.path == '/blocks' && options.method == 'POST') {
          return _json(_blocked());
        }
        if (options.path.startsWith('/friends/requests') &&
            options.method == 'POST') {
          return _json(_request());
        }
        return _json({'items': [], 'nextCursor': null});
      });
      final repository = _repository(adapter);

      await repository.getFriends();
      await repository.getFriendRequests(FriendRequestDirection.incoming);
      await repository.getBlocks();
      await repository.lookupPlayer('ada_l');
      await repository.sendFriendRequest(opponentId);
      await repository.acceptFriendRequest('r');
      await repository.declineFriendRequest('r');
      await repository.cancelFriendRequest('r');
      await repository.removeFriend(opponentId);
      await repository.blockPlayer(opponentId);
      await repository.unblockPlayer(opponentId);

      for (final path in adapter.requests.map((r) => r.path)) {
        for (final forbidden in ['wallet', 'financial', 'stake', 'settle']) {
          expect(path, isNot(contains(forbidden)));
        }
      }
    },
  );
}
