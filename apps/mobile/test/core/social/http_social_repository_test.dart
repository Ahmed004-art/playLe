import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/config/app_config.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/network/api_client.dart';
import 'package:playle_mobile/core/social/social_repository.dart';

import 'fake_social_repository.dart';

/// Answers every request with whatever [handler] returns (or throws), and
/// records the requests, so the repository can be tested through the real
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

Map<String, dynamic> _profileBody() => {
  'id': opponentId,
  'username': 'ada_l',
  'displayName': null,
  'gamesPlayed': 4,
  'wins': 2,
  'losses': 1,
  'draws': 1,
};

String _uuid(int n) =>
    '00000000-0000-4000-8000-${n.toRadixString(16).padLeft(12, '0')}';

void main() {
  group('getProfile', () {
    test('asks for exactly the profile endpoint and parses it', () async {
      final adapter = _StubAdapter((_) => _json(_profileBody()));

      final profile = await _repository(adapter).getProfile(opponentId);

      expect(adapter.requests, hasLength(1));
      expect(adapter.requests.single.method, 'GET');
      expect(adapter.requests.single.path, '/users/$opponentId/profile');
      expect(profile.username, 'ada_l');
      expect(profile.displayName, isNull);
      expect(profile.gamesPlayed, 4);
    });

    test('never reads anything beyond the contract, even if sent', () async {
      final adapter = _StubAdapter(
        (_) => _json({
          ..._profileBody(),
          'email': 'ada@example.com',
          'phoneNumber': '+23270000000',
          'walletBalance': '9999',
        }),
      );

      final profile = await _repository(adapter).getProfile(opponentId);

      expect(profile.id, opponentId);
      expect(profile.username, 'ada_l');
    });

    test('a 404 becomes a NetworkException carrying the status', () async {
      final adapter = _StubAdapter(
        (_) => _json({'statusCode': 404, 'message': 'Player not found'}, status: 404),
      );

      await expectLater(
        _repository(adapter).getProfile(opponentId),
        throwsA(
          isA<NetworkException>()
              .having((e) => e.statusCode, 'statusCode', 404)
              .having((e) => e.message, 'message', 'Player not found'),
        ),
      );
    });

    test('a 401 keeps its status so the screen can send the user to sign in', () async {
      final adapter = _StubAdapter(
        (_) => _json({'statusCode': 401, 'message': 'Unauthorized'}, status: 401),
      );

      await expectLater(
        _repository(adapter).getProfile(opponentId),
        throwsA(
          isA<NetworkException>().having((e) => e.statusCode, 'statusCode', 401),
        ),
      );
    });

    test('a connection failure has no status', () async {
      final adapter = _StubAdapter(
        (options) => throw DioException(
          requestOptions: options,
          type: DioExceptionType.connectionError,
          message: 'offline',
        ),
      );

      await expectLater(
        _repository(adapter).getProfile(opponentId),
        throwsA(
          isA<NetworkException>().having((e) => e.statusCode, 'statusCode', isNull),
        ),
      );
    });

    test('a malformed body is a NetworkException, not a crash', () async {
      final body = _profileBody()..remove('wins');
      final adapter = _StubAdapter((_) => _json(body));

      await expectLater(
        _repository(adapter).getProfile(opponentId),
        throwsA(isA<NetworkException>()),
      );
    });
  });

  group('getSummaries', () {
    test('makes no request for an empty list', () async {
      final adapter = _StubAdapter((_) => _json({'items': []}));

      expect(await _repository(adapter).getSummaries([]), isEmpty);
      expect(adapter.requests, isEmpty);
    });

    test('sends one comma-separated, de-duplicated request and parses items', () async {
      final adapter = _StubAdapter(
        (_) => _json({
          'items': [
            {'id': opponentId, 'username': 'ada_l', 'displayName': 'Ada'},
          ],
        }),
      );

      final summaries = await _repository(
        adapter,
      ).getSummaries([opponentId, otherOpponentId, opponentId]);

      expect(adapter.requests, hasLength(1));
      expect(adapter.requests.single.path, '/users/summaries');
      expect(adapter.requests.single.queryParameters['ids'], '$opponentId,$otherOpponentId');
      expect(summaries.single.displayLabel, 'Ada');
    });

    test('splits more than 50 ids across requests (the API rejects more)', () async {
      final adapter = _StubAdapter((_) => _json({'items': []}));
      final ids = List<String>.generate(120, _uuid);

      await _repository(adapter).getSummaries([...ids, ...ids]);

      expect(adapter.requests, hasLength(3));
      final sizes = adapter.requests
          .map((r) => (r.queryParameters['ids'] as String).split(',').length)
          .toList();
      expect(sizes, [50, 50, 20]);
      expect(sizes.every((n) => n <= maxSummaryIdsPerRequest), isTrue);
    });

    test('a malformed item is a NetworkException', () async {
      final adapter = _StubAdapter(
        (_) => _json({
          'items': [
            {'username': 'no id'},
          ],
        }),
      );

      await expectLater(
        _repository(adapter).getSummaries([opponentId]),
        throwsA(isA<NetworkException>()),
      );
    });
  });

  group('getMatchHistory', () {
    Map<String, dynamic> match(String id) => {
      'id': id,
      'gameId': 'tic_tac_toe',
      'status': 'COMPLETED',
      'winnerUserId': myId,
      'resultIsDraw': false,
      'terminationReason': null,
      'players': [
        {'userId': myId, 'seat': 0, 'connected': true},
        {'userId': opponentId, 'seat': 1, 'connected': true},
      ],
      'createdAt': '2026-10-20T10:00:00.000Z',
      'completedAt': '2026-10-20T10:05:00.000Z',
    };

    test('first page: no cursor, the requested limit', () async {
      final adapter = _StubAdapter(
        (_) => _json({'items': [match('m1')], 'nextCursor': 'm1'}),
      );

      final page = await _repository(adapter).getMatchHistory(limit: 15);

      expect(adapter.requests.single.path, '/matches');
      expect(adapter.requests.single.queryParameters, {'limit': 15});
      expect(page.items.single.id, 'm1');
      expect(page.nextCursor, 'm1');
    });

    test('later pages pass the cursor', () async {
      final adapter = _StubAdapter(
        (_) => _json({'items': [], 'nextCursor': null}),
      );

      final page = await _repository(adapter).getMatchHistory(cursor: 'm1');

      expect(adapter.requests.single.queryParameters, {'limit': 20, 'cursor': 'm1'});
      expect(page.nextCursor, isNull);
    });

    test('a 401 keeps its status', () async {
      final adapter = _StubAdapter(
        (_) => _json({'statusCode': 401, 'message': 'Unauthorized'}, status: 401),
      );

      await expectLater(
        _repository(adapter).getMatchHistory(),
        throwsA(
          isA<NetworkException>().having((e) => e.statusCode, 'statusCode', 401),
        ),
      );
    });
  });

  test('only ever talks to the profile, summaries and matches endpoints', () async {
    final adapter = _StubAdapter((options) {
      if (options.path == '/matches') {
        return _json({'items': [], 'nextCursor': null});
      }
      if (options.path == '/users/summaries') {
        return _json({'items': []});
      }
      return _json(_profileBody());
    });
    final repository = _repository(adapter);

    await repository.getProfile(opponentId);
    await repository.getSummaries([opponentId]);
    await repository.getMatchHistory();

    final paths = adapter.requests.map((r) => r.path).toSet();
    expect(paths, {'/users/$opponentId/profile', '/users/summaries', '/matches'});
    for (final path in paths) {
      expect(path, isNot(contains('wallet')));
      expect(path, isNot(contains('financial')));
      expect(path, isNot(contains('stake')));
    }
  });
}
