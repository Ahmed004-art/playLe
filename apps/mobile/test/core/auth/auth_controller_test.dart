import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/auth/auth_controller.dart';
import 'package:playle_mobile/core/auth/auth_state.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';

import 'fake_auth_repository.dart';

void main() {
  group('AuthController.bootstrap', () {
    test('restores an authenticated session when one exists', () async {
      final repo = FakeAuthRepository()..sessionToRestore = testUser;
      final controller = AuthController(repo);

      await controller.bootstrap();

      expect(controller.state, isA<AuthAuthenticated>());
      expect(controller.isAuthenticated, isTrue);
    });

    test('lands on Unauthenticated when there is no session', () async {
      final controller = AuthController(FakeAuthRepository());

      await controller.bootstrap();

      expect(controller.state, isA<AuthUnauthenticated>());
    });

    test(
      'lands on Unauthenticated (not a crash) when restoring errors out',
      () async {
        final repo = FakeAuthRepository()
          ..loadSessionError = const NetworkException('boom', statusCode: 500);
        final controller = AuthController(repo);

        await controller.bootstrap();

        expect(controller.state, isA<AuthUnauthenticated>());
      },
    );

    test('starts in AuthUnknown before bootstrap runs', () {
      final controller = AuthController(FakeAuthRepository());
      expect(controller.state, isA<AuthUnknown>());
    });
  });

  group('AuthController.register', () {
    test('transitions to Authenticated on success', () async {
      final controller = AuthController(FakeAuthRepository());

      await controller.register(
        email: 'player@example.com',
        username: 'playerone',
        password: 'Passw0rd1',
        dateOfBirth: DateTime(2000, 1, 1),
      );

      expect(controller.state, isA<AuthAuthenticated>());
    });

    test('rethrows and does not change state on failure', () async {
      final repo = FakeAuthRepository()
        ..nextError = const NetworkException(
          'Email already in use',
          statusCode: 409,
        );
      final controller = AuthController(repo);

      await expectLater(
        controller.register(
          email: 'player@example.com',
          username: 'playerone',
          password: 'Passw0rd1',
          dateOfBirth: DateTime(2000, 1, 1),
        ),
        throwsA(isA<NetworkException>()),
      );

      expect(controller.state, isA<AuthUnknown>());
    });
  });

  group('AuthController.login', () {
    test('transitions to Authenticated on success', () async {
      final controller = AuthController(FakeAuthRepository());

      await controller.login(
        identifier: 'player@example.com',
        password: 'Passw0rd1',
      );

      expect(controller.state, isA<AuthAuthenticated>());
    });

    test('surfaces invalid-credentials errors to the caller', () async {
      final repo = FakeAuthRepository()
        ..nextError = const NetworkException(
          'Invalid credentials',
          statusCode: 401,
        );
      final controller = AuthController(repo);

      await expectLater(
        controller.login(identifier: 'player@example.com', password: 'wrong'),
        throwsA(
          isA<NetworkException>().having(
            (e) => e.statusCode,
            'statusCode',
            401,
          ),
        ),
      );
    });
  });

  group('AuthController.logout', () {
    test('transitions to Unauthenticated', () async {
      final repo = FakeAuthRepository()..sessionToRestore = testUser;
      final controller = AuthController(repo);
      await controller.bootstrap();
      expect(controller.state, isA<AuthAuthenticated>());

      await controller.logout();

      expect(controller.state, isA<AuthUnauthenticated>());
      expect(repo.loggedOut, isTrue);
    });

    test('notifies listeners exactly once per state change', () async {
      final controller = AuthController(FakeAuthRepository());
      var notifications = 0;
      controller.addListener(() => notifications++);

      await controller.login(
        identifier: 'player@example.com',
        password: 'Passw0rd1',
      );
      await controller.logout();

      expect(notifications, 2);
    });
  });

  group('AuthController.changePassword', () {
    test(
      'transitions to Unauthenticated on success (all sessions revoked)',
      () async {
        final repo = FakeAuthRepository()..sessionToRestore = testUser;
        final controller = AuthController(repo);
        await controller.bootstrap();

        await controller.changePassword(
          currentPassword: 'OldPassw0rd1',
          newPassword: 'NewPassw0rd1',
        );

        expect(controller.state, isA<AuthUnauthenticated>());
        expect(repo.changedPassword, isTrue);
      },
    );

    test('rethrows on an incorrect current password', () async {
      final repo = FakeAuthRepository()
        ..nextError = const NetworkException(
          'Current password is incorrect',
          statusCode: 401,
        );
      final controller = AuthController(repo);

      await expectLater(
        controller.changePassword(
          currentPassword: 'wrong',
          newPassword: 'NewPassw0rd1',
        ),
        throwsA(isA<NetworkException>()),
      );
    });
  });
}
