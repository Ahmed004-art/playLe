import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/auth/auth_state.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';

import '../../core/social/fake_social_repository.dart';
import 'social_test_support.dart';

Future<void> _openProfile(
  WidgetTester tester,
  FakeSocialRepository social,
  SignedIn auth, {
  String userId = opponentId,
  bool settle = true,
}) async {
  useTallScreen(tester);
  final router = buildSocialRouter(
    auth: auth.controller,
    social: social,
    initialLocation: '/players/$userId',
  );
  await tester.pumpWidget(socialApp(router));
  if (settle) {
    await tester.pumpAndSettle();
  }
}

void main() {
  group('PlayerProfileScreen', () {
    testWidgets(
      'shows the name, handle, games played and win/draw/loss record',
      (tester) async {
        final social = FakeSocialRepository()
          ..profileToReturn = buildProfile(
            gamesPlayed: 10,
            wins: 6,
            losses: 3,
            draws: 1,
          );

        await _openProfile(tester, social, await signedIn());

        expect(find.text('Ada Lovelace'), findsOneWidget);
        expect(find.text('@ada_l'), findsOneWidget);
        expect(find.text('Games played'), findsOneWidget);
        expect(find.text('10'), findsOneWidget);
        expect(find.text('Wins'), findsOneWidget);
        expect(find.text('6'), findsOneWidget);
        expect(find.text('Draws'), findsOneWidget);
        expect(find.text('1'), findsOneWidget);
        expect(find.text('Losses'), findsOneWidget);
        expect(find.text('3'), findsOneWidget);
        expect(find.text('Player profile'), findsOneWidget);
        expect(social.profileRequests, [opponentId]);
      },
    );

    testWidgets('falls back to the username when there is no display name', (
      tester,
    ) async {
      final social = FakeSocialRepository()
        ..profileToReturn = buildProfile(displayName: null);

      await _openProfile(tester, social, await signedIn());

      expect(find.text('ada_l'), findsOneWidget); // the headline
      expect(find.text('@ada_l'), findsOneWidget); // the handle
    });

    testWidgets('shows initials, not an invented avatar image', (tester) async {
      final social = FakeSocialRepository()..profileToReturn = buildProfile();

      await _openProfile(tester, social, await signedIn());

      expect(find.text('AL'), findsOneWidget);
      expect(find.byType(Image), findsNothing);
    });

    testWidgets('a player with no completed games gets a message, not a bar', (
      tester,
    ) async {
      final social = FakeSocialRepository()
        ..profileToReturn = buildProfile(
          gamesPlayed: 0,
          wins: 0,
          losses: 0,
          draws: 0,
        );

      await _openProfile(tester, social, await signedIn());

      expect(find.text('No completed games yet.'), findsOneWidget);
      expect(find.text('Games played'), findsOneWidget);
      // The three counts are still shown, as zeros the server really sent.
      expect(find.text('0'), findsNWidgets(4));
    });

    testWidgets('describes the record in one sentence for a screen reader', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      final social = FakeSocialRepository()
        ..profileToReturn = buildProfile(
          gamesPlayed: 5,
          wins: 1,
          losses: 3,
          draws: 1,
        );

      await _openProfile(tester, social, await signedIn());

      expect(find.bySemanticsLabel('1 win, 1 draw, 3 losses'), findsOneWidget);
      handle.dispose();
    });

    testWidgets('your own profile says so', (tester) async {
      final social = FakeSocialRepository()
        ..profileToReturn = buildProfile(id: myId, username: 'playerone');

      await _openProfile(tester, social, await signedIn(), userId: myId);

      expect(find.text('My profile'), findsOneWidget);
      expect(find.text('This is you'), findsOneWidget);
    });

    testWidgets("someone else's profile does not", (tester) async {
      final social = FakeSocialRepository()..profileToReturn = buildProfile();

      await _openProfile(tester, social, await signedIn());

      expect(find.text('This is you'), findsNothing);
      expect(find.text('My profile'), findsNothing);
    });

    testWidgets('shows a spinner while loading, then the profile', (
      tester,
    ) async {
      final gate = Completer<void>();
      final social = FakeSocialRepository()
        ..profileToReturn = buildProfile()
        ..profileGate = gate;

      await _openProfile(tester, social, await signedIn(), settle: false);
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Ada Lovelace'), findsNothing);

      gate.complete();
      await tester.pumpAndSettle();

      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.text('Ada Lovelace'), findsOneWidget);
    });

    testWidgets('requests the profile once, however often it rebuilds', (
      tester,
    ) async {
      final social = FakeSocialRepository()..profileToReturn = buildProfile();
      final auth = await signedIn();
      useTallScreen(tester);
      final router = buildSocialRouter(
        auth: auth.controller,
        social: social,
        initialLocation: '/players/$opponentId',
      );
      await tester.pumpWidget(socialApp(router));
      await tester.pumpAndSettle();

      // Rebuild the whole app (and so the route's screen) several times.
      for (var i = 0; i < 3; i++) {
        await tester.pumpWidget(socialApp(router));
        await tester.pumpAndSettle();
      }

      expect(find.text('Ada Lovelace'), findsOneWidget);
      expect(social.profileCalls, 1);
    });

    testWidgets(
      'a network failure shows a retryable error, and Retry recovers',
      (tester) async {
        final social = FakeSocialRepository()
          ..profileToReturn = buildProfile()
          ..profileError = const NetworkException('connection errored');

        await _openProfile(tester, social, await signedIn());

        expect(
          find.text(
            'Could not reach PlayLe. Check your connection and try again.',
          ),
          findsOneWidget,
        );
        expect(find.text('Ada Lovelace'), findsNothing);

        social.profileError = null;
        await tester.tap(find.text('Retry'));
        await tester.pumpAndSettle();

        expect(find.text('Ada Lovelace'), findsOneWidget);
        expect(social.profileCalls, 2);
      },
    );

    testWidgets('a server error shows a friendly retryable message', (
      tester,
    ) async {
      final social = FakeSocialRepository()
        ..profileError = const NetworkException('boom', statusCode: 500);

      await _openProfile(tester, social, await signedIn());

      expect(
        find.text('Something went wrong on our side. Please try again.'),
        findsOneWidget,
      );
      expect(find.text('Retry'), findsOneWidget);
    });

    testWidgets(
      'a 404 (missing or hidden) shows "Player not found", with no retry',
      (tester) async {
        final social = FakeSocialRepository()
          ..profileError = const NetworkException(
            'Player not found',
            statusCode: 404,
          );

        await _openProfile(tester, social, await signedIn());

        expect(find.text('Player not found'), findsOneWidget);
        expect(find.text("This player isn't available."), findsOneWidget);
        expect(find.text('Retry'), findsNothing);
      },
    );

    testWidgets('"Go back" returns to where you came from', (tester) async {
      final social = FakeSocialRepository()
        ..profileError = const NetworkException(
          'Player not found',
          statusCode: 404,
        );
      final auth = await signedIn();
      useTallScreen(tester);
      final router = buildSocialRouter(auth: auth.controller, social: social);
      await tester.pumpWidget(socialApp(router));
      await tester.pumpAndSettle();

      unawaited(router.push('/players/$opponentId'));
      await tester.pumpAndSettle();
      expect(find.text('Player not found'), findsOneWidget);

      await tester.tap(find.text('Go back'));
      await tester.pumpAndSettle();

      expect(find.text('Player not found'), findsNothing);
      expect(find.text('@playerone'), findsOneWidget); // the account hub
    });

    testWidgets(
      '"Go back" with nothing to go back to lands on the account hub',
      (tester) async {
        final social = FakeSocialRepository()
          ..profileError = const NetworkException(
            'Player not found',
            statusCode: 404,
          );

        await _openProfile(tester, social, await signedIn());
        await tester.tap(find.text('Go back'));
        await tester.pumpAndSettle();

        expect(find.text('@playerone'), findsOneWidget);
      },
    );

    testWidgets(
      'a route id that is not a user id is "not found" without a request',
      (tester) async {
        final social = FakeSocialRepository();

        await _openProfile(
          tester,
          social,
          await signedIn(),
          userId: 'not-a-user',
        );

        expect(find.text('Player not found'), findsOneWidget);
        expect(social.profileCalls, 0);
      },
    );

    testWidgets(
      'an expired session offers to sign in again, through the existing auth flow',
      (tester) async {
        final social = FakeSocialRepository()
          ..profileError = const NetworkException(
            'Unauthorized',
            statusCode: 401,
          );
        final auth = await signedIn();

        await _openProfile(tester, social, auth);

        expect(find.text('Session expired'), findsOneWidget);
        expect(
          find.text('Your session has expired. Please sign in again.'),
          findsOneWidget,
        );
        expect(find.text('Retry'), findsNothing);

        await tester.tap(find.text('Sign in again'));
        await tester.pump();

        expect(auth.repository.loggedOut, isTrue);
        expect(auth.controller.state, isA<AuthUnauthenticated>());
      },
    );

    testWidgets('shows no private account information', (tester) async {
      final social = FakeSocialRepository()..profileToReturn = buildProfile();
      final auth = await signedIn();

      await _openProfile(tester, social, auth);

      for (final private in [
        'player@example.com', // the signed-in player's own email
        '@example.com',
        'Email',
        'Phone',
        'Date of birth',
        'Wallet',
        'Balance',
        'Stake',
        'Transaction',
        'Role',
        'Status',
      ]) {
        expect(
          find.textContaining(private),
          findsNothing,
          reason: '"$private" must not appear on a profile',
        );
      }
      // It asked for the profile and nothing else.
      expect(social.profileCalls, 1);
      expect(social.summaryRequests, isEmpty);
      expect(social.historyCalls, 0);
    });
  });
}
