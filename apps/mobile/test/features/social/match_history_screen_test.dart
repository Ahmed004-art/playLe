import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/auth/auth_state.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/social/social_models.dart';

import '../../core/social/fake_social_repository.dart';
import 'social_test_support.dart';

Future<void> _openHistory(
  WidgetTester tester,
  FakeSocialRepository social,
  SignedIn auth, {
  bool settle = true,
}) async {
  useTallScreen(tester);
  final router = buildSocialRouter(
    auth: auth.controller,
    social: social,
    initialLocation: '/history',
  );
  await tester.pumpWidget(socialApp(router));
  if (settle) {
    await tester.pumpAndSettle();
  }
}

String _dateOf(DateTime utc) => formatShortDate(utc.toLocal());

void main() {
  group('MatchHistoryScreen', () {
    testWidgets('shows a spinner while loading', (tester) async {
      final social = FakeSocialRepository();
      // The first request never completes until the test lets it.
      final gate = Completer<void>();
      final gated = _GatedSocialRepository(social, gate);

      useTallScreen(tester);
      final auth = await signedIn();
      final router = buildSocialRouter(
        auth: auth.controller,
        social: gated,
        initialLocation: '/history',
      );
      await tester.pumpWidget(socialApp(router));
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      gate.complete();
      await tester.pumpAndSettle();
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('shows a friendly empty state when there are no matches', (
      tester,
    ) async {
      final social = FakeSocialRepository();

      await _openHistory(tester, social, await signedIn());

      expect(
        find.text('No matches yet. Play a game and it will show up here.'),
        findsOneWidget,
      );
      expect(find.text('Load more'), findsNothing);
    });

    testWidgets('lists real matches with game, opponent, result and date', (
      tester,
    ) async {
      final done = DateTime.utc(2026, 10, 21, 9);
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [
              buildMatch(id: 'won', winnerUserId: myId, completedAt: done),
              buildMatch(
                id: 'lost',
                gameId: 'dice',
                winnerUserId: opponentId,
                terminationReason: 'RESIGNATION',
                completedAt: done,
              ),
              buildMatch(id: 'draw', resultIsDraw: true, completedAt: done),
            ],
            nextCursor: null,
          ),
        ]
        ..summariesToReturn = const [
          PlayerSummary(id: opponentId, username: 'ada_l', displayName: 'Ada'),
        ];

      await _openHistory(tester, social, await signedIn());

      expect(find.text('Won'), findsOneWidget);
      expect(find.text('Lost'), findsOneWidget);
      expect(find.text('Draw'), findsOneWidget);
      expect(find.text('You resigned.'), findsOneWidget);
      expect(find.text('Tic-Tac-Toe · vs Ada'), findsNWidgets(2));
      expect(find.text('Dice · vs Ada'), findsOneWidget); // not in the catalog
      expect(find.text(_dateOf(done)), findsNWidgets(3));
      // One batch request for every opponent, not one per row.
      expect(social.summaryRequests, hasLength(1));
    });

    testWidgets('abandoned, cancelled and in-progress matches are not wins or losses', (
      tester,
    ) async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [
              buildMatch(
                id: 'a',
                status: 'ABANDONED',
                winnerUserId: myId,
                terminationReason: 'ABANDONED_DISCONNECT',
              ),
              buildMatch(
                id: 'c',
                status: 'CANCELLED',
                terminationReason: 'WAITING_TIMEOUT',
              ),
              buildMatch(id: 'p', status: 'ACTIVE'),
              buildMatch(id: 'w', status: 'WAITING'),
              buildMatch(id: 'x'),
            ],
            nextCursor: null,
          ),
        ];

      await _openHistory(tester, social, await signedIn());

      expect(find.text('Abandoned'), findsOneWidget);
      expect(find.text('Cancelled'), findsOneWidget);
      expect(find.text('The match never started.'), findsOneWidget);
      expect(find.text('In progress'), findsOneWidget);
      expect(find.text('Waiting to start'), findsOneWidget);
      expect(find.text('Result not recorded'), findsOneWidget);
      expect(find.text('Won'), findsNothing);
      expect(find.text('Lost'), findsNothing);
    });

    testWidgets('a hidden opponent is shown as unavailable, not invented', (
      tester,
    ) async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [buildMatch(id: 'm', winnerUserId: myId)],
            nextCursor: null,
          ),
        ];

      await _openHistory(tester, social, await signedIn());

      expect(
        find.text('Tic-Tac-Toe · vs Player unavailable'),
        findsOneWidget,
      );
    });

    testWidgets('shows nothing about money', (tester) async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [buildMatch(id: 'm', winnerUserId: myId)],
            nextCursor: null,
          ),
        ];

      await _openHistory(tester, social, await signedIn());

      for (final money in ['Stake', 'SLE', 'Prize', 'Wallet', 'Balance']) {
        expect(find.textContaining(money), findsNothing, reason: money);
      }
    });

    testWidgets('loads more on request and then stops offering it', (tester) async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [buildMatch(id: 'm1', winnerUserId: myId)],
            nextCursor: 'm1',
          ),
          MatchHistoryPage(
            items: [buildMatch(id: 'm2', winnerUserId: opponentId)],
            nextCursor: null,
          ),
        ];

      await _openHistory(tester, social, await signedIn());
      expect(find.text('Won'), findsOneWidget);
      expect(find.text('Lost'), findsNothing);

      await tester.tap(find.text('Load more'));
      await tester.pumpAndSettle();

      expect(find.text('Won'), findsOneWidget);
      expect(find.text('Lost'), findsOneWidget);
      expect(find.text('Load more'), findsNothing);
      expect(social.historyCursors, [null, 'm1']);
    });

    testWidgets('a failed next page keeps the list and offers Retry', (
      tester,
    ) async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [buildMatch(id: 'm1', winnerUserId: myId)],
            nextCursor: 'm1',
          ),
          MatchHistoryPage(
            items: [buildMatch(id: 'm2', winnerUserId: opponentId)],
            nextCursor: null,
          ),
          MatchHistoryPage(
            items: [buildMatch(id: 'm2', winnerUserId: opponentId)],
            nextCursor: null,
          ),
        ]
        ..historyErrorsByCall[1] = const NetworkException('offline');

      await _openHistory(tester, social, await signedIn());
      await tester.tap(find.text('Load more'));
      await tester.pumpAndSettle();

      expect(find.text('Won'), findsOneWidget); // still there
      expect(
        find.text('Could not reach PlayLe. Check your connection and try again.'),
        findsOneWidget,
      );

      social.historyErrorsByCall.clear();
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();

      expect(find.text('Lost'), findsOneWidget);
      expect(find.text('Retry'), findsNothing);
    });

    testWidgets('a first-page failure shows a retryable error', (tester) async {
      final social = FakeSocialRepository()
        ..historyErrorsByCall[0] = const NetworkException('offline');

      await _openHistory(tester, social, await signedIn());

      expect(
        find.text('Could not reach PlayLe. Check your connection and try again.'),
        findsOneWidget,
      );

      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();

      expect(
        find.text('No matches yet. Play a game and it will show up here.'),
        findsOneWidget,
      );
    });

    testWidgets('an expired session offers to sign in again, through the existing auth flow', (
      tester,
    ) async {
      final social = FakeSocialRepository()
        ..historyErrorsByCall[0] =
            const NetworkException('Unauthorized', statusCode: 401);
      final auth = await signedIn();

      await _openHistory(tester, social, auth);

      expect(
        find.text('Your session has expired. Please sign in again.'),
        findsOneWidget,
      );
      expect(find.text('Retry'), findsNothing);

      await tester.tap(find.text('Sign in again'));
      await tester.pump();

      expect(auth.repository.loggedOut, isTrue);
      expect(auth.controller.state, isA<AuthUnauthenticated>());
    });

    testWidgets('opens the opponent\'s profile, and back returns to the history', (
      tester,
    ) async {
      final social = FakeSocialRepository()
        ..profileToReturn = buildProfile(displayName: 'Ada Lovelace')
        ..pages = [
          MatchHistoryPage(
            items: [buildMatch(id: 'm', winnerUserId: myId)],
            nextCursor: null,
          ),
        ]
        ..summariesToReturn = const [
          PlayerSummary(id: opponentId, username: 'ada_l', displayName: 'Ada'),
        ];

      await _openHistory(tester, social, await signedIn());
      await tester.tap(find.text('Won'));
      await tester.pumpAndSettle();

      expect(find.text('Player profile'), findsOneWidget);
      expect(find.text('@ada_l'), findsOneWidget);
      expect(social.profileRequests, [opponentId]);

      await tester.pageBack();
      await tester.pumpAndSettle();

      expect(find.text('Match history'), findsOneWidget);
      expect(find.text('Won'), findsOneWidget);
    });

    testWidgets('a match with several opponents does not open a single profile', (
      tester,
    ) async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [
              buildMatch(
                id: 'g',
                winnerUserId: myId,
                players: [myId, opponentId, otherOpponentId],
              ),
            ],
            nextCursor: null,
          ),
        ];

      await _openHistory(tester, social, await signedIn());
      await tester.tap(find.text('Won'));
      await tester.pumpAndSettle();

      expect(find.text('Match history'), findsOneWidget);
      expect(social.profileCalls, 0);
    });

    testWidgets('without a signed-in player it asks them to sign in and fetches nothing', (
      tester,
    ) async {
      final social = FakeSocialRepository();
      final auth = await signedIn();
      await auth.controller.logout();

      await _openHistory(tester, social, auth);

      expect(find.text('Sign in to see your match history.'), findsOneWidget);
      expect(social.historyCalls, 0);
    });
  });
}

/// Delegates to a [FakeSocialRepository] but holds the first history request
/// until [gate] completes, so a test can look at the loading state.
class _GatedSocialRepository extends FakeSocialRepository {
  _GatedSocialRepository(this._inner, this._gate);

  final FakeSocialRepository _inner;
  final Completer<void> _gate;

  @override
  Future<MatchHistoryPage> getMatchHistory({
    String? cursor,
    int limit = 20,
  }) async {
    await _gate.future;
    return _inner.getMatchHistory(cursor: cursor, limit: limit);
  }
}
