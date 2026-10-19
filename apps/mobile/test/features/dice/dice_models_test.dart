import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/features/dice/dice_models.dart';

Map<String, dynamic> _roll(String userId, List<int> dice) => {
  'userId': userId,
  'dice': dice,
  'total': dice[0] + dice[1],
};

Map<String, dynamic> _state({
  Map<String, dynamic>? pendingRoll,
  List<Map<String, dynamic>> attempts = const [],
  List<int> roundWins = const [0, 0],
}) {
  return {
    'playerOrder': ['user-1', 'user-2'],
    'currentTurn': 'user-1',
    'round': 1,
    'roundWins': roundWins,
    'consecutiveTies': 0,
    'pendingRoll': pendingRoll,
    'attempts': attempts,
    'winnerUserId': null,
    'isDraw': false,
  };
}

void main() {
  group('DiceBoardState.fromJson', () {
    test('parses an untouched match', () {
      final state = DiceBoardState.fromJson(_state());

      expect(state.playerOrder, ['user-1', 'user-2']);
      expect(state.currentTurn, 'user-1');
      expect(state.round, 1);
      expect(state.pendingRoll, isNull);
      expect(state.attempts, isEmpty);
      expect(state.lastAttempt, isNull);
      expect(state.isDraw, isFalse);
    });

    test('parses a pending roll', () {
      final pending = _roll('user-1', [3, 4]);
      final state = DiceBoardState.fromJson(_state(pendingRoll: pending));

      expect(state.pendingRoll?.userId, 'user-1');
      expect(state.pendingRoll?.dice, [3, 4]);
      expect(state.pendingRoll?.total, 7);
    });

    test('parses attempts and flags a tie', () {
      final first = _roll('user-1', [3, 4]);
      final second = _roll('user-2', [2, 5]);
      final tiedAttempt = {
        'round': 1,
        'rolls': [first, second],
        'winnerUserId': null,
      };
      final state = DiceBoardState.fromJson(_state(attempts: [tiedAttempt]));

      expect(state.attempts, hasLength(1));
      expect(state.lastAttempt?.isTie, isTrue);
      expect(state.lastAttempt?.round, 1);
      expect(state.lastAttempt?.rolls[1].userId, 'user-2');
    });

    test('winsFor reads the score by seat', () {
      final state = DiceBoardState.fromJson(_state(roundWins: const [1, 0]));

      expect(state.winsFor('user-1'), 1);
      expect(state.winsFor('user-2'), 0);
      expect(state.winsFor('someone-else'), 0);
    });

    test('rounds to win matches the server rule', () {
      expect(DiceBoardState.roundsToWin, 2);
    });
  });
}
