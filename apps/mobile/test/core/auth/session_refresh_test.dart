import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/auth/auth_controller.dart';
import 'package:playle_mobile/core/auth/auth_repository.dart';
import 'package:playle_mobile/core/auth/auth_state.dart';
import 'package:playle_mobile/core/auth/session_refresher.dart';
import 'package:playle_mobile/core/config/app_config.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/network/api_client.dart';

import '../realtime/fake_secure_storage.dart';
import 'fake_auth_repository.dart';

/// Plays the API's side of token expiry: `/auth/refresh` rotates the refresh
/// token and refuses one it has already seen; every other route answers 401
/// unless it carries the current access token.
class _FakeServer implements HttpClientAdapter {
  String validAccess = 'access-2';
  String issuedAccess = 'access-2';
  String validRefresh = 'refresh-1';
  int refreshCalls = 0;
  int refreshStatus = 200;
  final List<String> paths = [];
  final Set<String> usedRefreshTokens = {};

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    paths.add(options.path);
    if (options.path == '/auth/refresh') {
      refreshCalls++;
      final sent = (options.data as Map)['refreshToken'] as String;
      if (refreshStatus != 200) {
        return _reply({'message': 'no'}, refreshStatus);
      }
      if (sent != validRefresh || usedRefreshTokens.contains(sent)) {
        return _reply({'message': 'reuse'}, 401);
      }
      usedRefreshTokens.add(sent);
      validRefresh = 'refresh-${refreshCalls + 1}';
      return _reply({
        'accessToken': issuedAccess,
        'refreshToken': validRefresh,
      }, 200);
    }
    if (options.headers['Authorization'] == 'Bearer $validAccess') {
      if (options.path == '/auth/me') {
        return _reply({
          'id': 'u1',
          'email': 'a@b.co',
          'username': 'ada',
          'role': 'USER',
          'status': 'ACTIVE',
        }, 200);
      }
      return _reply({'ok': true}, 200);
    }
    return _reply({'message': 'expired'}, 401);
  }

  ResponseBody _reply(Object body, int status) => ResponseBody.fromString(
    jsonEncode(body),
    status,
    headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    },
  );

  @override
  void close({bool force = false}) {}
}

class _Harness {
  _Harness() {
    storage
      ..write(AuthStorageKeys.accessToken, 'access-1')
      ..write(AuthStorageKeys.refreshToken, 'refresh-1');
    final dio = Dio(BaseOptions(baseUrl: 'http://test.invalid/api/v1'))
      ..httpClientAdapter = server;
    late final ApiClient client;
    refresher = SessionRefresher(
      apiClient: ApiClient(
        config: _config,
        dio: Dio(BaseOptions(baseUrl: 'http://test.invalid/api/v1'))
          ..httpClientAdapter = server,
      ),
      secureStorage: storage,
      onSessionLost: () => sessionLost++,
    );
    client = ApiClient(
      config: _config,
      getAccessToken: () => storage.read(AuthStorageKeys.accessToken),
      refreshSession: refresher.refresh,
      dio: dio,
    );
    api = client;
  }

  static const _config = AppConfig(
    environment: Environment.development,
    apiBaseUrl: 'http://test.invalid/api/v1',
    socketUrl: 'http://test.invalid',
  );

  final server = _FakeServer();
  final storage = FakeSecureStorage();
  late final SessionRefresher refresher;
  late final ApiClient api;
  int sessionLost = 0;
}

Matcher _status(int code) =>
    isA<NetworkException>().having((e) => e.statusCode, 'statusCode', code);

void main() {
  test('a 401 is renewed once and the request is retried', () async {
    final h = _Harness();

    final response = await h.api.get<Map<String, dynamic>>('/matches');

    expect(response.data, {'ok': true});
    expect(h.server.refreshCalls, 1);
    expect(h.server.paths, ['/matches', '/auth/refresh', '/matches']);
    expect(await h.storage.read(AuthStorageKeys.accessToken), 'access-2');
    expect(await h.storage.read(AuthStorageKeys.refreshToken), 'refresh-2');
    expect(h.sessionLost, 0);
  });

  test('requests that expire together share ONE refresh', () async {
    final h = _Harness();

    final results = await Future.wait([
      h.api.get<Map<String, dynamic>>('/matches'),
      h.api.get<Map<String, dynamic>>('/friends'),
      h.api.get<Map<String, dynamic>>('/wallet'),
    ]);

    expect(results.map((r) => r.statusCode), [200, 200, 200]);
    // A second refresh would present an already-rotated token, which the API
    // treats as theft and answers by ending the session.
    expect(h.server.refreshCalls, 1);
    expect(h.sessionLost, 0);
  });

  test('a refused refresh token ends the session once', () async {
    final h = _Harness()..server.refreshStatus = 401;

    await expectLater(
      h.api.get<Map<String, dynamic>>('/matches'),
      throwsA(_status(401)),
    );
    await expectLater(
      h.api.get<Map<String, dynamic>>('/friends'),
      throwsA(_status(401)),
    );

    expect(await h.storage.read(AuthStorageKeys.accessToken), isNull);
    expect(await h.storage.read(AuthStorageKeys.refreshToken), isNull);
    // The callback is idempotent (AuthController ignores it once signed out);
    // the second request found no refresh token and never called the server.
    expect(h.sessionLost, greaterThanOrEqualTo(1));
    expect(h.server.refreshCalls, 1);
  });

  test('a transient refresh failure keeps the session', () async {
    final h = _Harness()..server.refreshStatus = 503;

    await expectLater(
      h.api.get<Map<String, dynamic>>('/matches'),
      throwsA(isA<NetworkException>()),
    );

    expect(await h.storage.read(AuthStorageKeys.refreshToken), 'refresh-1');
    expect(h.sessionLost, 0);
  });

  test('a request is retried at most once', () async {
    final h = _Harness()..server.validAccess = 'never-issued';
    // The refresh "succeeds" but hands out a token the routes still refuse.
    h.server.issuedAccess = 'still-refused';

    await expectLater(
      h.api.get<Map<String, dynamic>>('/matches'),
      throwsA(_status(401)),
    );

    expect(h.server.paths.where((p) => p == '/matches').length, 2);
    expect(h.server.refreshCalls, 1);
  });

  test('a wrong-password 401 on /auth/login is not refreshed', () async {
    final h = _Harness();

    await expectLater(
      h.api.post<Map<String, dynamic>>('/auth/login', data: {}),
      throwsA(_status(401)),
    );

    expect(h.server.refreshCalls, 0);
  });

  test(
    'a request already renewed by another is retried without refreshing',
    () async {
      final h = _Harness();
      // Another request renewed the session while this one was in flight.
      await h.storage.write(AuthStorageKeys.accessToken, 'access-2');

      final response = await h.api.post<Map<String, dynamic>>(
        '/matches',
        data: {},
        headers: {'Authorization': 'Bearer access-1'},
      );

      expect(response.statusCode, 200);
      expect(h.server.refreshCalls, 0);
    },
  );

  test(
    'AuthController.sessionExpired signs out only an active session',
    () async {
      final repo = FakeAuthRepository()..sessionToRestore = testUser;
      final controller = AuthController(repo);

      controller.sessionExpired();
      expect(controller.state, isA<AuthUnknown>());

      await controller.bootstrap();
      expect(controller.state, isA<AuthAuthenticated>());

      controller.sessionExpired();
      expect(controller.state, isA<AuthUnauthenticated>());
    },
  );

  group('HttpAuthRepository.loadSession', () {
    test('restores an expired session with exactly one refresh', () async {
      final h = _Harness();
      final repo = HttpAuthRepository(
        apiClient: h.api,
        secureStorage: h.storage,
      );

      final user = await repo.loadSession();

      expect(user?.username, 'ada');
      expect(h.server.refreshCalls, 1);
      expect(await h.storage.read(AuthStorageKeys.refreshToken), 'refresh-2');
    });

    test('a refused refresh token ends with no session', () async {
      final h = _Harness()..server.refreshStatus = 401;
      final repo = HttpAuthRepository(
        apiClient: h.api,
        secureStorage: h.storage,
      );

      expect(await repo.loadSession(), isNull);
      expect(await h.storage.read(AuthStorageKeys.refreshToken), isNull);
      expect(h.server.refreshCalls, 1);
    });

    test('a transient failure keeps the saved session', () async {
      final h = _Harness()..server.refreshStatus = 503;
      final repo = HttpAuthRepository(
        apiClient: h.api,
        secureStorage: h.storage,
      );

      await expectLater(repo.loadSession(), throwsA(isA<NetworkException>()));
      expect(await h.storage.read(AuthStorageKeys.refreshToken), 'refresh-1');
    });
  });
}
