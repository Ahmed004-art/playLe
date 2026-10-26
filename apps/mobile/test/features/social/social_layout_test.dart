import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/social/social_models.dart';
import 'package:playle_mobile/core/theme/app_theme.dart';
import 'package:playle_mobile/features/social/match_history_screen.dart';
import 'package:playle_mobile/features/social/player_profile_screen.dart';

import '../../core/games/fake_games_repository.dart';
import '../../core/social/fake_social_repository.dart';
import 'social_test_support.dart';

/// Narrow-screen and large-text audit of the two new screens, in the same
/// spirit as `match_chrome_layout_test.dart`: Flutter's test font is roughly
/// twice as wide as a real one, so passing at 2x text scale here is a stricter
/// bar than a real device presents. A layout passes when nothing overflows
/// (no RenderFlex/clipping exception) and the critical content is in the tree.
///
/// This is widget-level evidence only - it is not an on-device check.
const _widths = [320.0, 360.0, 390.0];
const _scales = [1.0, 1.5, 2.0];

Future<void> _pump(
  WidgetTester tester,
  Widget screen, {
  required double width,
  required double scale,
}) async {
  // Tall, so every row of a list is built even when large text makes the
  // rows tall; the point of the test is overflow, not scrolling.
  tester.view.physicalSize = Size(width, 4000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.dark,
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ),
      home: screen,
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  for (final width in _widths) {
    for (final scale in _scales) {
      final where = '${width.toInt()} px at ${scale}x text';

      testWidgets('profile screen does not overflow at $where', (tester) async {
        final social = FakeSocialRepository()
          ..profileToReturn = buildProfile(
            displayName: 'A Rather Long Display Name Indeed',
            username: 'a_rather_long_username_too',
            gamesPlayed: 1234,
            wins: 1000,
            losses: 200,
            draws: 34,
          );
        final auth = await signedIn();

        await _pump(
          tester,
          PlayerProfileScreen(
            userId: opponentId,
            repository: social,
            authController: auth.controller,
          ),
          width: width,
          scale: scale,
        );

        expect(tester.takeException(), isNull);
        expect(find.text('Wins'), findsOneWidget);
        expect(find.text('1000'), findsOneWidget);
      });

      testWidgets('profile "not found" does not overflow at $where', (
        tester,
      ) async {
        final auth = await signedIn();

        await _pump(
          tester,
          PlayerProfileScreen(
            userId: 'not-a-user',
            repository: FakeSocialRepository(),
            authController: auth.controller,
          ),
          width: width,
          scale: scale,
        );

        expect(tester.takeException(), isNull);
        expect(find.text('Player not found'), findsOneWidget);
      });

      testWidgets('match history does not overflow at $where', (tester) async {
        final social = FakeSocialRepository()
          ..pages = [
            MatchHistoryPage(
              items: [
                buildMatch(
                  id: 'a',
                  gameId: 'a_game_with_a_very_long_identifier',
                  winnerUserId: opponentId,
                  terminationReason: 'TURN_TIMEOUT',
                ),
                buildMatch(id: 'b', status: 'CANCELLED'),
              ],
              nextCursor: 'b',
            ),
          ]
          ..summariesToReturn = const [
            PlayerSummary(
              id: opponentId,
              username: 'a_rather_long_username_too',
              displayName: 'An Opponent With A Rather Long Display Name',
            ),
          ];
        final auth = await signedIn();

        await _pump(
          tester,
          MatchHistoryScreen(
            repository: social,
            gamesRepository: FakeGamesRepository(),
            authController: auth.controller,
          ),
          width: width,
          scale: scale,
        );

        expect(tester.takeException(), isNull);
        expect(find.text('Lost'), findsOneWidget);
        expect(find.text('Load more'), findsOneWidget);
      });
    }
  }
}
