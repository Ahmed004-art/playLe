import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/social/player_profile_controller.dart';
import 'package:playle_mobile/core/social/player_profile_state.dart';

import 'fake_social_repository.dart';

PlayerProfileController _controller(
  FakeSocialRepository repository, {
  String userId = opponentId,
}) {
  return PlayerProfileController(repository, userId: userId);
}

void main() {
  group('PlayerProfileController', () {
    test('starts loading, then holds the loaded profile', () async {
      final repository = FakeSocialRepository()
        ..profileToReturn = buildProfile(wins: 6, losses: 3, draws: 1);
      final controller = _controller(repository);
      addTearDown(controller.dispose);

      expect(controller.state, isA<PlayerProfileLoading>());
      await controller.load();

      final state = controller.state;
      expect(state, isA<PlayerProfileLoaded>());
      expect((state as PlayerProfileLoaded).profile.wins, 6);
      expect(repository.profileRequests, [opponentId]);
    });

    test('a 404 is "not found" (hidden and missing look the same)', () async {
      final repository = FakeSocialRepository()
        ..profileError = const NetworkException('Player not found', statusCode: 404);
      final controller = _controller(repository);
      addTearDown(controller.dispose);

      await controller.load();

      expect(controller.state, isA<PlayerProfileNotFound>());
    });

    test('a 400 (malformed id) is also "not found"', () async {
      final repository = FakeSocialRepository()
        ..profileError = const NetworkException('Bad id', statusCode: 400);
      final controller = _controller(repository);
      addTearDown(controller.dispose);

      await controller.load();

      expect(controller.state, isA<PlayerProfileNotFound>());
    });

    test('an id that is not a user id never reaches the server', () async {
      final repository = FakeSocialRepository();
      final controller = _controller(repository, userId: '../wallet');
      addTearDown(controller.dispose);

      await controller.load();

      expect(controller.state, isA<PlayerProfileNotFound>());
      expect(repository.profileCalls, 0);
    });

    test('a 401 is unauthorized, not a retryable error', () async {
      final repository = FakeSocialRepository()
        ..profileError = const NetworkException('Unauthorized', statusCode: 401);
      final controller = _controller(repository);
      addTearDown(controller.dispose);

      await controller.load();

      expect(controller.state, isA<PlayerProfileUnauthorized>());
    });

    test('a connection failure is a friendly retryable error', () async {
      final repository = FakeSocialRepository()
        ..profileError = const NetworkException('connection errored');
      final controller = _controller(repository);
      addTearDown(controller.dispose);

      await controller.load();

      final state = controller.state;
      expect(state, isA<PlayerProfileError>());
      expect(
        (state as PlayerProfileError).message,
        'Could not reach PlayLe. Check your connection and try again.',
      );
    });

    test('a server error is a friendly retryable error', () async {
      final repository = FakeSocialRepository()
        ..profileError = const NetworkException('boom', statusCode: 503);
      final controller = _controller(repository);
      addTearDown(controller.dispose);

      await controller.load();

      expect(
        (controller.state as PlayerProfileError).message,
        'Something went wrong on our side. Please try again.',
      );
    });

    test('an unexpected exception is a generic error, never a crash', () async {
      final repository = FakeSocialRepository()..profileError = StateError('x');
      final controller = _controller(repository);
      addTearDown(controller.dispose);

      await controller.load();

      expect(
        (controller.state as PlayerProfileError).message,
        'Something went wrong. Please try again.',
      );
    });

    test('retry after an error loads the profile', () async {
      final repository = FakeSocialRepository()
        ..profileError = const NetworkException('offline');
      final controller = _controller(repository);
      addTearDown(controller.dispose);
      await controller.load();
      expect(controller.state, isA<PlayerProfileError>());

      repository.profileError = null;
      await controller.load();

      expect(controller.state, isA<PlayerProfileLoaded>());
      expect(repository.profileCalls, 2);
    });

    test('does not fetch twice while a request is already in flight', () async {
      final gate = Completer<void>();
      final repository = FakeSocialRepository()..profileGate = gate;
      final controller = _controller(repository);
      addTearDown(controller.dispose);

      final first = controller.load();
      final second = controller.load();
      final third = controller.load();
      gate.complete();
      await Future.wait([first, second, third]);

      expect(repository.profileCalls, 1);
      expect(controller.state, isA<PlayerProfileLoaded>());
    });

    test('a reply that arrives after dispose is dropped without error', () async {
      final gate = Completer<void>();
      final repository = FakeSocialRepository()..profileGate = gate;
      final controller = _controller(repository);

      final loading = controller.load();
      controller.dispose();
      gate.complete();

      // Would throw "used after being disposed" if the reply were applied.
      await loading;
      expect(repository.profileCalls, 1);
    });

    test('notifies listeners on each state change', () async {
      final repository = FakeSocialRepository();
      final controller = _controller(repository);
      addTearDown(controller.dispose);
      var notifications = 0;
      controller.addListener(() => notifications++);

      await controller.load();

      // Loading, then loaded.
      expect(notifications, 2);
    });
  });
}
