import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/match/match_models.dart';
import 'package:playle_mobile/core/match/widgets/financial_result_banner.dart';
import 'package:playle_mobile/core/match_stakes/match_stake_models.dart';
import 'package:playle_mobile/features/dice/dice_screen.dart';
import 'package:playle_mobile/features/dice/dice_widgets.dart';

import '../../core/match/fake_match_repository.dart'
    show buildTestStake, buildTestSettlement;

Map<String, dynamic> _roll(String userId, int a, int b) => {
  'userId': userId,
  'dice': [a, b],
  'total': a + b,
};

Map<String, dynamic> _attempt(int round, String? winner, List rolls) => {
  'round': round,
  'rolls': rolls,
  'winnerUserId': winner,
};

MatchInfo _match({
  String status = 'ACTIVE',
  String currentTurn = 'user-1',
  int round = 1,
  List<int> roundWins = const [0, 0],
  int consecutiveTies = 0,
  Map<String, dynamic>? pendingRoll,
  List<Map<String, dynamic>> attempts = const [],
  String? winnerUserId,
  bool resultIsDraw = false,
  String? terminationReason,
  bool opponentConnected = true,
}) {
  return MatchInfo(
    id: 'match-1',
    gameId: 'dice',
    status: status,
    stateVersion: 1,
    state: {
      'playerOrder': ['user-1', 'user-2'],
      'currentTurn': currentTurn,
      'round': round,
      'roundWins': roundWins,
      'consecutiveTies': consecutiveTies,
      'pendingRoll': pendingRoll,
      'attempts': attempts,
      'winnerUserId': winnerUserId,
      'isDraw': resultIsDraw,
    },
    winnerUserId: winnerUserId,
    resultIsDraw: resultIsDraw,
    terminationReason: terminationReason,
    supportsDraws: false,
    players: [
      const MatchPlayerInfo(userId: 'user-1', seat: 0, connected: true),
      MatchPlayerInfo(userId: 'user-2', seat: 1, connected: opponentConnected),
    ],
  );
}

/// Overrides `disableAnimations` for everything below it, so a test can
/// exercise the reduced-motion path without touching platform settings.
class _Harness extends StatelessWidget {
  const _Harness({required this.reduceMotion, required this.child});

  final bool reduceMotion;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final data = MediaQuery.of(context);
    return MediaQuery(
      data: data.copyWith(disableAnimations: reduceMotion),
      child: child,
    );
  }
}

Widget _wrap(
  MatchInfo match, {
  Future<void> Function()? onRoll,
  Future<void> Function()? onResign,
  MatchFinancialInfo financial = const MatchFinancialInfo.empty(),
  String? lastRejection,
  bool reduceMotion = false,
}) {
  return MaterialApp(
    home: _Harness(
      reduceMotion: reduceMotion,
      child: DiceScreen(
        match: match,
        currentUserId: 'user-1',
        lastRejection: lastRejection,
        onRoll: onRoll ?? () async {},
        onExit: () {},
        onResign: onResign ?? () async {},
        financial: financial,
      ),
    ),
  );
}

void _usePhoneSize(WidgetTester tester, {Size size = const Size(390, 844)}) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

int? _dieValue(WidgetTester tester, String key) {
  final face = find.descendant(
    of: find.byKey(ValueKey(key)),
    matching: find.byType(DiceFace),
  );
  return tester.widget<DiceFace>(face).value;
}

String? _totalText(WidgetTester tester, String key) {
  return tester.widget<Text>(find.byKey(ValueKey(key))).data;
}

DiceFaceEmphasis _emphasisOf(WidgetTester tester, String key) {
  final face = find.descendant(
    of: find.byKey(ValueKey(key)),
    matching: find.byType(DiceFace),
  );
  return tester.widget<DiceFace>(face).emphasis;
}

int _pipWins(WidgetTester tester, Key rowKey) {
  final pips = find.descendant(
    of: find.byKey(rowKey),
    matching: find.byType(RoundPips),
  );
  return tester.widget<RoundPips>(pips).wins;
}

bool _rollEnabled(WidgetTester tester) {
  final button = tester.widget<FilledButton>(find.byKey(DiceKeys.rollButton));
  return button.onPressed != null;
}

void main() {
  group('DiceScreen', () {
    testWidgets('shows Your turn and enables the roll button', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(_wrap(_match()));

      expect(find.text('Your turn'), findsOneWidget);
      expect(find.text('Roll dice'), findsOneWidget);
      expect(_rollEnabled(tester), isTrue);
    });

    testWidgets('disables roll on the opponent turn', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(_wrap(_match(currentTurn: 'user-2')));

      expect(find.text("Opponent's turn"), findsOneWidget);
      expect(find.text('Waiting for opponent...'), findsOneWidget);
      expect(_rollEnabled(tester), isFalse);
    });

    testWidgets('tapping roll calls onRoll exactly once', (tester) async {
      _usePhoneSize(tester);
      var calls = 0;
      await tester.pumpWidget(
        _wrap(
          _match(),
          onRoll: () async {
            calls++;
          },
        ),
      );

      await tester.tap(find.byKey(DiceKeys.rollButton));
      await tester.pump();

      expect(calls, 1);
    });

    testWidgets('shows Rolling while the roll is in flight', (tester) async {
      _usePhoneSize(tester);
      final rollCompleter = Completer<void>();
      await tester.pumpWidget(
        _wrap(_match(), onRoll: () => rollCompleter.future),
      );

      await tester.tap(find.byKey(DiceKeys.rollButton));
      await tester.pump();
      expect(find.text('Rolling...'), findsOneWidget);
      expect(_rollEnabled(tester), isFalse);

      rollCompleter.complete();
      await tester.pump();
      await tester.pump();
      expect(find.text('Rolling...'), findsNothing);
      expect(find.text('Roll dice'), findsOneWidget);
    });

    testWidgets("renders the opponent's server-rolled dice", (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(
        _wrap(_match(pendingRoll: _roll('user-2', 3, 4))),
      );

      expect(_dieValue(tester, 'theirs-die-0'), 3);
      expect(_dieValue(tester, 'theirs-die-1'), 4);
      expect(_totalText(tester, 'theirs-total'), '7');
      expect(find.text('Your opponent rolled 7. Your turn!'), findsOneWidget);
    });

    testWidgets('shows my own pending roll and waits', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(
        _wrap(
          _match(currentTurn: 'user-2', pendingRoll: _roll('user-1', 6, 2)),
        ),
      );

      expect(_dieValue(tester, 'mine-die-0'), 6);
      expect(_dieValue(tester, 'mine-die-1'), 2);
      expect(_totalText(tester, 'mine-total'), '8');
      expect(
        find.text('Your roll is in. Waiting for your opponent.'),
        findsOneWidget,
      );
      expect(_rollEnabled(tester), isFalse);
    });

    testWidgets('never invents a value for an unrolled die', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(_wrap(_match()));

      expect(_dieValue(tester, 'mine-die-0'), isNull);
      expect(_dieValue(tester, 'theirs-die-1'), isNull);
      expect(_totalText(tester, 'mine-total'), '-');
      expect(find.text('You roll first. Good luck!'), findsOneWidget);
    });

    testWidgets('highlights the round winner and loser dice', (tester) async {
      _usePhoneSize(tester);
      final attempt = _attempt(1, 'user-1', [
        _roll('user-1', 6, 5),
        _roll('user-2', 2, 1),
      ]);
      await tester.pumpWidget(
        _wrap(
          _match(
            currentTurn: 'user-2',
            round: 2,
            roundWins: const [1, 0],
            attempts: [attempt],
          ),
        ),
      );

      expect(_totalText(tester, 'mine-total'), '11');
      expect(_totalText(tester, 'theirs-total'), '3');
      expect(_emphasisOf(tester, 'mine-die-0'), DiceFaceEmphasis.winner);
      expect(_emphasisOf(tester, 'theirs-die-0'), DiceFaceEmphasis.loser);
      expect(find.text('You won round 1!'), findsOneWidget);
      expect(find.text('Round 2'), findsOneWidget);
    });

    testWidgets('announces a tied round and the tie counter', (tester) async {
      _usePhoneSize(tester);
      final tie = _attempt(1, null, [
        _roll('user-1', 3, 4),
        _roll('user-2', 2, 5),
      ]);
      await tester.pumpWidget(
        _wrap(_match(consecutiveTies: 1, attempts: [tie])),
      );

      expect(find.text('Tied at 7. Roll again!'), findsOneWidget);
      expect(
        find.text('Tie 1 of 3. Three in a row ends the match in a draw.'),
        findsOneWidget,
      );
      expect(_emphasisOf(tester, 'mine-die-0'), DiceFaceEmphasis.neutral);
    });

    testWidgets('shows round score pips for both players', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(_wrap(_match(roundWins: const [1, 0])));

      expect(_pipWins(tester, DiceKeys.mineRow), 1);
      expect(_pipWins(tester, DiceKeys.theirsRow), 0);
    });

    testWidgets('shows a win banner when the player wins', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(
        _wrap(_match(status: 'COMPLETED', winnerUserId: 'user-1')),
      );

      expect(find.text('You won! 🎉'), findsOneWidget);
    });

    testWidgets('shows a loss banner when the player loses', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(
        _wrap(_match(status: 'COMPLETED', winnerUserId: 'user-2')),
      );

      expect(find.text('You lost'), findsOneWidget);
    });

    testWidgets('shows a draw banner and the tie explanation', (tester) async {
      _usePhoneSize(tester);
      final ties = [
        for (var round = 0; round < 3; round++)
          _attempt(1, null, [_roll('user-1', 3, 3), _roll('user-2', 3, 3)]),
      ];
      await tester.pumpWidget(
        _wrap(
          _match(
            status: 'COMPLETED',
            resultIsDraw: true,
            consecutiveTies: 3,
            attempts: ties,
          ),
        ),
      );

      expect(find.text("It's a draw!"), findsOneWidget);
      expect(
        find.text('Three ties in a row. The match is a draw.'),
        findsOneWidget,
      );
      expect(find.textContaining('Tie 3 of 3'), findsNothing);
      expect(find.textContaining('Tied at'), findsNothing);
    });

    testWidgets('hides the round caption once finished', (tester) async {
      _usePhoneSize(tester);
      final won = _attempt(1, 'user-1', [
        _roll('user-1', 6, 5),
        _roll('user-2', 2, 1),
      ]);
      await tester.pumpWidget(
        _wrap(
          _match(
            status: 'COMPLETED',
            winnerUserId: 'user-2',
            terminationReason: 'RESIGNATION',
            round: 2,
            roundWins: const [1, 0],
            attempts: [won],
          ),
        ),
      );

      expect(find.byKey(const ValueKey('stage-caption')), findsNothing);
      expect(find.text('You won round 1!'), findsNothing);
      expect(find.text('You resigned.'), findsOneWidget);
      expect(find.text('You lost'), findsOneWidget);
    });

    testWidgets('explains a resignation outcome', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(
        _wrap(
          _match(
            status: 'COMPLETED',
            winnerUserId: 'user-2',
            terminationReason: 'RESIGNATION',
          ),
        ),
      );
      expect(find.text('You resigned.'), findsOneWidget);

      await tester.pumpWidget(
        _wrap(
          _match(
            status: 'COMPLETED',
            winnerUserId: 'user-1',
            terminationReason: 'RESIGNATION',
          ),
        ),
      );
      expect(find.text('Your opponent resigned.'), findsOneWidget);
    });

    testWidgets('has no stage caption after an early resign', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(
        _wrap(
          _match(
            status: 'COMPLETED',
            winnerUserId: 'user-2',
            terminationReason: 'RESIGNATION',
          ),
        ),
      );

      expect(find.byKey(const ValueKey('stage-caption')), findsNothing);
    });

    testWidgets('explains a turn-timeout outcome', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(
        _wrap(
          _match(
            status: 'COMPLETED',
            winnerUserId: 'user-2',
            terminationReason: 'TURN_TIMEOUT',
          ),
        ),
      );
      expect(find.text('You ran out of time to roll.'), findsOneWidget);
      expect(find.text('You lost'), findsOneWidget);
    });

    testWidgets('hides roll and resign once finished', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(
        _wrap(_match(status: 'COMPLETED', winnerUserId: 'user-1')),
      );

      expect(find.byKey(DiceKeys.rollButton), findsNothing);
      expect(find.text('Resign'), findsNothing);
    });

    testWidgets('shows Resign but never Offer draw', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(_wrap(_match()));

      expect(find.text('Resign'), findsOneWidget);
      expect(find.text('Offer draw'), findsNothing);
    });

    testWidgets('resigning requires confirmation before calling onResign', (
      tester,
    ) async {
      _usePhoneSize(tester);
      var resigned = false;
      await tester.pumpWidget(
        _wrap(
          _match(),
          onResign: () async {
            resigned = true;
          },
        ),
      );

      await tester.tap(find.widgetWithText(OutlinedButton, 'Resign'));
      await tester.pumpAndSettle();
      expect(find.text('Resign this match?'), findsOneWidget);
      expect(resigned, isFalse);

      await tester.tap(find.widgetWithText(FilledButton, 'Resign'));
      await tester.pumpAndSettle();
      expect(resigned, isTrue);
    });

    testWidgets('cancelling the dialog does not resign', (tester) async {
      _usePhoneSize(tester);
      var resigned = false;
      await tester.pumpWidget(
        _wrap(
          _match(),
          onResign: () async {
            resigned = true;
          },
        ),
      );

      await tester.tap(find.widgetWithText(OutlinedButton, 'Resign'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(resigned, isFalse);
    });

    testWidgets('shows the rejection message from the server', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(
        _wrap(_match(), lastRejection: 'It is not your turn'),
      );

      expect(find.text('It is not your turn'), findsOneWidget);
    });

    testWidgets('shows when the opponent disconnects', (tester) async {
      // Default (wide) viewport, like the Checkers equivalent: the shared
      // MatchStatusBar overflows in the test font at phone width. That is
      // tracked in OUTSTANDING_WORK item 25, not a Dice-specific problem.
      await tester.pumpWidget(_wrap(_match(opponentConnected: false)));

      expect(find.text('Opponent disconnected'), findsOneWidget);
    });

    testWidgets('shows stake bar during a staked match', (tester) async {
      // Default (wide) viewport: the shared MatchStakeStatusBar overflows
      // in the test font at phone width (OUTSTANDING_WORK item 25).
      final stake = buildTestStake(
        stakeAmountMinor: '1000',
        poolAmountMinor: '2000',
      );
      await tester.pumpWidget(
        _wrap(
          _match(),
          financial: MatchFinancialInfo(stake: stake, settlement: null),
        ),
      );

      expect(find.textContaining('Entry Le 10.00'), findsOneWidget);
      expect(find.textContaining('Pool Le 20.00'), findsOneWidget);
    });

    testWidgets('free play shows no stake bar', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(_wrap(_match()));

      expect(find.textContaining('Entry '), findsNothing);
      expect(find.textContaining('Pool '), findsNothing);
    });

    testWidgets('shows the financial banner once settled', (tester) async {
      _usePhoneSize(tester);
      final settlement = buildTestSettlement(outcome: 'WIN');
      await tester.pumpWidget(
        _wrap(
          _match(status: 'COMPLETED', winnerUserId: 'user-1'),
          financial: MatchFinancialInfo(stake: null, settlement: settlement),
        ),
      );

      expect(find.text('You won! 🎉'), findsOneWidget);
      expect(find.textContaining('Prize pool Le 20.00'), findsOneWidget);
    });

    testWidgets('shows dice instantly with reduced motion', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(_wrap(_match(), reduceMotion: true));
      await tester.pumpWidget(
        _wrap(_match(pendingRoll: _roll('user-2', 3, 4)), reduceMotion: true),
      );
      await tester.pump();

      expect(tester.hasRunningAnimations, isFalse);
      expect(_dieValue(tester, 'theirs-die-0'), 3);
      expect(_dieValue(tester, 'theirs-die-1'), 4);
    });

    testWidgets('tumbles then settles on the server value', (tester) async {
      _usePhoneSize(tester);
      await tester.pumpWidget(_wrap(_match()));
      await tester.pumpWidget(
        _wrap(_match(pendingRoll: _roll('user-2', 3, 4))),
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.hasRunningAnimations, isTrue);

      await tester.pumpAndSettle();
      expect(tester.hasRunningAnimations, isFalse);
      expect(_dieValue(tester, 'theirs-die-0'), 3);
      expect(_dieValue(tester, 'theirs-die-1'), 4);
      expect(_totalText(tester, 'theirs-total'), '7');
    });

    testWidgets('fits a small 320px phone without overflow', (tester) async {
      _usePhoneSize(tester, size: const Size(320, 568));
      final attempt = _attempt(1, 'user-2', [
        _roll('user-1', 1, 2),
        _roll('user-2', 6, 6),
      ]);
      await tester.pumpWidget(
        _wrap(
          _match(
            round: 2,
            roundWins: const [0, 1],
            consecutiveTies: 1,
            attempts: [attempt],
          ),
        ),
      );

      expect(tester.takeException(), isNull);
      expect(find.text('Roll dice'), findsOneWidget);
    });

    testWidgets('keeps both roll rows visible when short', (tester) async {
      _usePhoneSize(tester, size: const Size(320, 640));
      final tie = _attempt(1, null, [
        _roll('user-1', 3, 4),
        _roll('user-2', 2, 5),
      ]);
      await tester.pumpWidget(
        _wrap(_match(consecutiveTies: 1, attempts: [tie])),
      );

      // Neither row may extend under the fixed roll button.
      final button = tester.getRect(find.byKey(DiceKeys.rollButton));
      final mine = tester.getRect(find.byKey(DiceKeys.mineRow));
      final theirs = tester.getRect(find.byKey(DiceKeys.theirsRow));
      expect(theirs.bottom, lessThanOrEqualTo(button.top));
      expect(mine.bottom, lessThanOrEqualTo(button.top));
    });

    testWidgets('keeps final dice above the result banner', (tester) async {
      _usePhoneSize(tester, size: const Size(320, 640));
      final won = _attempt(1, 'user-1', [
        _roll('user-1', 6, 5),
        _roll('user-2', 2, 1),
      ]);
      final settlement = buildTestSettlement(outcome: 'WIN');
      await tester.pumpWidget(
        _wrap(
          _match(
            status: 'COMPLETED',
            winnerUserId: 'user-1',
            roundWins: const [2, 0],
            round: 2,
            attempts: [won],
          ),
          financial: MatchFinancialInfo(stake: null, settlement: settlement),
        ),
      );

      final banner = tester.getRect(find.byType(FinancialResultBanner));
      final mine = tester.getRect(find.byKey(DiceKeys.mineRow));
      expect(mine.bottom, lessThanOrEqualTo(banner.top));
    });
  });

  group('DiceFace', () {
    testWidgets('draws the right pips for each face', (tester) async {
      for (var value = 1; value <= 6; value++) {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(body: DiceFace(value: value)),
          ),
        );
        expect(find.byKey(const ValueKey('dice-pip')), findsNWidgets(value));
      }
    });

    testWidgets('shows a placeholder and no pips when unrolled', (
      tester,
    ) async {
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: DiceFace(value: null))),
      );

      expect(find.byKey(const ValueKey('dice-pip')), findsNothing);
      expect(find.text('?'), findsOneWidget);
    });
  });
}
