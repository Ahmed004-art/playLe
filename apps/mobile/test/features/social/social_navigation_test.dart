import 'package:flutter_test/flutter_test.dart';

import '../../core/social/fake_social_repository.dart';
import 'social_test_support.dart';

/// Navigation to and from the new screens, through real `go_router`
/// navigation from the account hub (the entry point this PR adds).
void main() {
  group('Account hub entry points', () {
    testWidgets(
      '"My profile" opens your own profile, and back returns to the hub',
      (tester) async {
        final social = FakeSocialRepository()
          ..profileToReturn = buildProfile(
            id: myId,
            username: 'playerone',
            displayName: null,
          );
        final auth = await signedIn();
        useTallScreen(tester);
        await tester.pumpWidget(
          socialApp(buildSocialRouter(auth: auth.controller, social: social)),
        );
        await tester.pumpAndSettle();

        await tester.ensureVisible(find.text('My profile'));
        await tester.tap(find.text('My profile'));
        await tester.pumpAndSettle();

        // The app bar says so, and it is this player's own record.
        expect(find.text('This is you'), findsOneWidget);
        expect(social.profileRequests, [myId]);

        await tester.pageBack();
        await tester.pumpAndSettle();

        expect(find.text('This is you'), findsNothing);
        expect(find.text('@playerone'), findsOneWidget); // the account hub
        expect(find.text('My profile'), findsOneWidget); // the hub's button
      },
    );

    testWidgets(
      '"Match history" opens the history, and back returns to the hub',
      (tester) async {
        final social = FakeSocialRepository();
        final auth = await signedIn();
        useTallScreen(tester);
        await tester.pumpWidget(
          socialApp(buildSocialRouter(auth: auth.controller, social: social)),
        );
        await tester.pumpAndSettle();

        await tester.ensureVisible(find.text('Match history'));
        await tester.tap(find.text('Match history'));
        await tester.pumpAndSettle();

        expect(
          find.text('No matches yet. Play a game and it will show up here.'),
          findsOneWidget,
        );
        expect(social.historyCalls, 1);

        await tester.pageBack();
        await tester.pumpAndSettle();

        expect(find.text('@playerone'), findsOneWidget);
      },
    );

    testWidgets(
      '"Friends" opens the friends screen, and back returns to the hub',
      (tester) async {
        final social = FakeSocialRepository();
        final auth = await signedIn();
        useTallScreen(tester);
        await tester.pumpWidget(
          socialApp(buildSocialRouter(auth: auth.controller, social: social)),
        );
        await tester.pumpAndSettle();

        await tester.ensureVisible(find.text('Friends'));
        await tester.tap(find.text('Friends'));
        await tester.pumpAndSettle();

        expect(
          find.text('Requests'),
          findsOneWidget,
        ); // a tab of the new screen
        expect(find.text('Blocked'), findsOneWidget);
        expect(social.callsTo('friends'), 1);

        await tester.pageBack();
        await tester.pumpAndSettle();

        expect(find.text('@playerone'), findsOneWidget);
        expect(find.text('Requests'), findsNothing);
      },
    );
    testWidgets(
      'both entries sit beside the existing ones, which are still there',
      (tester) async {
        final social = FakeSocialRepository();
        final auth = await signedIn();
        useTallScreen(tester);
        await tester.pumpWidget(
          socialApp(buildSocialRouter(auth: auth.controller, social: social)),
        );
        await tester.pumpAndSettle();

        for (final label in [
          'Games',
          'Wallet',
          'Friends',
          'My profile',
          'Match history',
          'My Disputes',
          'Two-factor authentication',
          'Active sessions',
          'Responsible gaming',
          'Log out',
        ]) {
          expect(find.text(label), findsOneWidget, reason: label);
        }
      },
    );
  });

  group('Opening a profile from another route', () {
    testWidgets(
      'a deep link to a profile shows that player, not the previous one',
      (tester) async {
        final social = FakeSocialRepository()
          ..profileToReturn = buildProfile(
            id: otherOpponentId,
            username: 'grace_h',
            displayName: 'Grace Hopper',
          );
        final auth = await signedIn();
        useTallScreen(tester);
        final router = buildSocialRouter(
          auth: auth.controller,
          social: social,
          initialLocation: '/players/$otherOpponentId',
        );
        await tester.pumpWidget(socialApp(router));
        await tester.pumpAndSettle();

        expect(find.text('Grace Hopper'), findsOneWidget);
        expect(social.profileRequests, [otherOpponentId]);
      },
    );

    testWidgets('moving from one profile to another loads the new player', (
      tester,
    ) async {
      final social = FakeSocialRepository();
      final auth = await signedIn();
      useTallScreen(tester);
      final router = buildSocialRouter(
        auth: auth.controller,
        social: social,
        initialLocation: '/players/$opponentId',
      );
      await tester.pumpWidget(socialApp(router));
      await tester.pumpAndSettle();

      router.go('/players/$otherOpponentId');
      await tester.pumpAndSettle();

      expect(social.profileRequests, [opponentId, otherOpponentId]);
    });
  });
}
