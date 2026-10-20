import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/match/match_models.dart';
import 'package:playle_mobile/core/match/widgets/financial_result_banner.dart';
import 'package:playle_mobile/core/match/widgets/match_action_bar.dart';
import 'package:playle_mobile/core/match/widgets/match_result_banner.dart';
import 'package:playle_mobile/core/match/widgets/match_stake_status_bar.dart';
import 'package:playle_mobile/core/match/widgets/match_status_bar.dart';
import 'package:playle_mobile/core/match_stakes/match_stake_models.dart';
import 'package:playle_mobile/core/theme/app_colors.dart';
import 'package:playle_mobile/core/theme/app_spacing.dart';
import 'package:playle_mobile/core/theme/app_theme.dart';
import 'package:playle_mobile/features/checkers/checkers_screen.dart';
import 'package:playle_mobile/features/dice/dice_screen.dart';
import 'package:playle_mobile/features/tic_tac_toe/tic_tac_toe_screen.dart';

import 'fake_match_repository.dart' show buildTestStake, buildTestSettlement;

/// Narrow-screen and large-text audit of the shared match chrome and the
/// three game screens (OUTSTANDING_WORK item 25). Flutter's test font is
/// roughly twice as wide as a real one, so passing here at 2x text scale is
/// a deliberately stricter bar than any real device presents. A layout
/// passes when nothing overflows (no RenderFlex/clipping exception) and the
/// critical information is still in the tree.
///
/// This is widget-level evidence only — it is not an on-device check.
const _widths = [320.0, 390.0];
const _scales = [1.0, 1.5, 2.0];

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  required double width,
  required double scale,
  double height = 900,
}) async {
  tester.view.physicalSize = Size(width, height);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.dark,
      home: _Scaled(scale: scale, child: child),
    ),
  );
}

class _Scaled extends StatelessWidget {
  const _Scaled({required this.scale, required this.child});

  final double scale;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final data = MediaQuery.of(context);
    return MediaQuery(
      data: data.copyWith(textScaler: TextScaler.linear(scale)),
      child: child,
    );
  }
}

/// Chrome widgets are laid out the way the game screens lay them out: in a
/// column inside the screen's standard padding.
Widget _inScreenPadding(List<Widget> children) {
  return Scaffold(
    body: Padding(
      padding: const EdgeInsets.all(AppSpacing.xl),
      child: Column(children: children),
    ),
  );
}

Widget _pieces() {
  return Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Container(
        width: 14,
        height: 14,
        decoration: const BoxDecoration(
          shape: BoxShape.circle,
          color: AppColors.pieceP1,
        ),
      ),
      const SizedBox(width: AppSpacing.sm),
      const Text('Your pieces'),
    ],
  );
}

Widget _markIndicator() {
  return const Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Icon(Icons.close_rounded, color: AppColors.primary),
      SizedBox(width: AppSpacing.sm),
      Text('You play X'),
    ],
  );
}

MatchInfo _info(
  String gameId,
  Map<String, dynamic> state, {
  bool opponentConnected = true,
  DateTime? deadline,
  bool supportsDraws = true,
}) {
  return MatchInfo(
    id: 'match-1',
    gameId: gameId,
    status: 'ACTIVE',
    stateVersion: 1,
    state: state,
    winnerUserId: null,
    resultIsDraw: false,
    turnDeadlineAt: deadline,
    supportsDraws: supportsDraws,
    players: [
      const MatchPlayerInfo(userId: 'user-1', seat: 0, connected: true),
      MatchPlayerInfo(userId: 'user-2', seat: 1, connected: opponentConnected),
    ],
  );
}

MatchFinancialInfo _bigStake() {
  final stake = buildTestStake(
    stakeAmountMinor: '123456789',
    poolAmountMinor: '246913578',
  );
  return MatchFinancialInfo(stake: stake, settlement: null);
}

void main() {
  for (final width in _widths) {
    for (final scale in _scales) {
      group('shared chrome at ${width.toInt()}px, ${scale}x text', () {
        testWidgets('status bar: my turn with a minutes countdown', (
          tester,
        ) async {
          await _pump(
            tester,
            _inScreenPadding([
              MatchStatusBar(
                leading: _pieces(),
                opponentConnected: true,
                isMyTurn: true,
                finished: false,
                turnDeadlineAt: DateTime.now().add(const Duration(seconds: 95)),
              ),
            ]),
            width: width,
            scale: scale,
          );

          expect(tester.takeException(), isNull);
          expect(find.text('Your turn'), findsOneWidget);
          expect(find.textContaining('left)'), findsOneWidget);
          expect(find.text('Your pieces'), findsOneWidget);
        });

        testWidgets("status bar: opponent's turn with a countdown", (
          tester,
        ) async {
          await _pump(
            tester,
            _inScreenPadding([
              MatchStatusBar(
                leading: _markIndicator(),
                opponentConnected: true,
                isMyTurn: false,
                finished: false,
                turnDeadlineAt: DateTime.now().add(const Duration(seconds: 25)),
              ),
            ]),
            width: width,
            scale: scale,
          );

          expect(tester.takeException(), isNull);
          expect(find.text("Opponent's turn"), findsOneWidget);
          expect(find.textContaining('left)'), findsOneWidget);
        });

        testWidgets('status bar: opponent disconnected', (tester) async {
          await _pump(
            tester,
            _inScreenPadding([
              MatchStatusBar(
                leading: _pieces(),
                opponentConnected: false,
                isMyTurn: true,
                finished: false,
              ),
            ]),
            width: width,
            scale: scale,
          );

          expect(tester.takeException(), isNull);
          expect(find.text('Opponent disconnected'), findsOneWidget);
        });

        testWidgets('stake bar: large amounts stay readable', (tester) async {
          await _pump(
            tester,
            _inScreenPadding([MatchStakeStatusBar(stake: _bigStake().stake!)]),
            width: width,
            scale: scale,
          );

          expect(tester.takeException(), isNull);
          expect(find.textContaining('Entry'), findsOneWidget);
          expect(find.textContaining('Pool'), findsOneWidget);
        });

        testWidgets('action bar: both actions', (tester) async {
          await _pump(
            tester,
            _inScreenPadding([
              MatchActionBar(
                supportsResignation: true,
                supportsDraws: true,
                busy: false,
                onResign: () {},
                onOfferDraw: () {},
              ),
            ]),
            width: width,
            scale: scale,
          );

          expect(tester.takeException(), isNull);
          expect(find.text('Offer draw'), findsOneWidget);
          expect(find.text('Resign'), findsOneWidget);
        });

        for (final mine in [true, false]) {
          testWidgets('draw offer banner (mine: $mine)', (tester) async {
            await _pump(
              tester,
              _inScreenPadding([
                DrawOfferBanner(
                  isMine: mine,
                  busy: false,
                  onAccept: () {},
                  onReject: () {},
                ),
              ]),
              width: width,
              scale: scale,
            );

            expect(tester.takeException(), isNull);
            expect(find.text(mine ? 'Cancel' : 'Accept'), findsOneWidget);
          });
        }

        testWidgets('result banners', (tester) async {
          await _pump(
            tester,
            _inScreenPadding([
              MatchResultBanner(won: true, isDraw: false, onExit: () {}),
              FinancialResultBanner(
                currentUserId: 'user-1',
                settlement: buildTestSettlement(outcome: 'WIN'),
                onExit: () {},
                onDispute: (_) async {},
              ),
            ]),
            width: width,
            scale: scale,
            height: 1400,
          );

          expect(tester.takeException(), isNull);
          expect(find.text('You won! 🎉'), findsWidgets);
        });
      });
    }
  }

  // Regression: the bar must span the full width with the leading widget at
  // the left edge and the status at the right edge, exactly like the original
  // Row layout. (A bare Wrap shrink-wrapped it into a narrow centered pill —
  // caught by the Chrome preview, invisible to the overflow checks above.)
  for (final width in _widths) {
    testWidgets('status bar spans the full width at ${width.toInt()}px', (
      tester,
    ) async {
      await _pump(
        tester,
        _inScreenPadding([
          const MatchStatusBar(
            leading: SizedBox(key: ValueKey('lead'), width: 18, height: 18),
            opponentConnected: true,
            isMyTurn: true,
            finished: false,
          ),
        ]),
        width: width,
        scale: 1,
      );

      final bar = tester.getRect(find.byType(MatchStatusBar));
      expect(bar.width, width - 2 * AppSpacing.xl);

      final lead = tester.getRect(find.byKey(const ValueKey('lead')));
      final status = tester.getRect(find.text('Your turn'));
      // Padding inside the bar is AppSpacing.lg on each side.
      expect(lead.left - bar.left, closeTo(AppSpacing.lg, 0.5));
      expect(bar.right - status.right, closeTo(AppSpacing.lg, 0.5));
    });
  }

  // Whole screens in their most crowded realistic state: a stake bar, a
  // minutes countdown, and the action bar all at once.
  for (final width in _widths) {
    for (final scale in const [1.5, 2.0]) {
      group('screens at ${width.toInt()}px, ${scale}x text', () {
        final deadline = DateTime.now().add(const Duration(seconds: 25));

        testWidgets('Tic-Tac-Toe, staked, opponent turn', (tester) async {
          final match = _info('tic_tac_toe', {
            'board': List<String?>.filled(9, null),
            'playerOrder': ['user-1', 'user-2'],
            'moveCount': 1,
          }, deadline: deadline);
          await _pump(
            tester,
            TicTacToeScreen(
              match: match,
              currentUserId: 'user-1',
              lastRejection: null,
              onMove: (_) async {},
              onExit: () {},
              onResign: () async {},
              onOfferDraw: () async {},
              onAcceptDraw: () async {},
              onRejectDraw: () async {},
              financial: _bigStake(),
            ),
            width: width,
            scale: scale,
            height: 900,
          );

          expect(tester.takeException(), isNull);
          expect(find.textContaining('Entry'), findsOneWidget);
        });

        testWidgets('Checkers, staked, opponent turn', (tester) async {
          final match = _info('checkers', {
            'board': List.generate(
              8,
              (_) => List<Map<String, dynamic>?>.filled(8, null),
            ),
            'playerOrder': ['user-1', 'user-2'],
            'currentTurn': 'user-2',
            'mustContinueFrom': null,
            'movesSinceProgress': 0,
          }, deadline: deadline);
          await _pump(
            tester,
            CheckersScreen(
              match: match,
              currentUserId: 'user-1',
              lastRejection: null,
              onMove: (_, _) async {},
              onExit: () {},
              onResign: () async {},
              onOfferDraw: () async {},
              onAcceptDraw: () async {},
              onRejectDraw: () async {},
              financial: _bigStake(),
            ),
            width: width,
            scale: scale,
            height: 900,
          );

          expect(tester.takeException(), isNull);
          expect(find.textContaining('Entry'), findsOneWidget);
        });

        testWidgets('Dice, staked, opponent turn', (tester) async {
          final match = _info(
            'dice',
            {
              'playerOrder': ['user-1', 'user-2'],
              'currentTurn': 'user-2',
              'round': 1,
              'roundWins': [0, 0],
              'consecutiveTies': 1,
              'pendingRoll': null,
              'attempts': [
                {
                  'round': 1,
                  'rolls': [
                    {
                      'userId': 'user-1',
                      'dice': [3, 4],
                      'total': 7,
                    },
                    {
                      'userId': 'user-2',
                      'dice': [2, 5],
                      'total': 7,
                    },
                  ],
                  'winnerUserId': null,
                },
              ],
              'winnerUserId': null,
              'isDraw': false,
            },
            deadline: deadline,
            supportsDraws: false,
          );
          await _pump(
            tester,
            DiceScreen(
              match: match,
              currentUserId: 'user-1',
              lastRejection: null,
              onRoll: () async {},
              onExit: () {},
              onResign: () async {},
              financial: _bigStake(),
            ),
            width: width,
            scale: scale,
            height: 900,
          );

          expect(tester.takeException(), isNull);
          expect(find.textContaining('Entry'), findsOneWidget);
        });
      });
    }
  }
}
