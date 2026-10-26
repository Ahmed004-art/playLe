import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/social/social_models.dart';

import 'fake_social_repository.dart';

Map<String, dynamic> _profileJson({Map<String, dynamic>? overrides}) {
  return {
    'id': opponentId,
    'username': 'ada_l',
    'displayName': 'Ada Lovelace',
    'gamesPlayed': 10,
    'wins': 6,
    'losses': 3,
    'draws': 1,
    ...?overrides,
  };
}

Map<String, dynamic> _matchJson({Map<String, dynamic>? overrides}) {
  return {
    'id': 'match-1',
    'gameId': 'tic_tac_toe',
    'gameVersion': 1,
    'status': 'COMPLETED',
    'stateVersion': 7,
    'state': {'board': List.filled(9, null)},
    'winnerUserId': myId,
    'resultIsDraw': false,
    'terminationReason': null,
    'turnDeadlineAt': null,
    'pendingDrawOfferByUserId': null,
    'supportsResignation': true,
    'supportsDraws': true,
    'players': [
      {'userId': myId, 'seat': 0, 'connected': true},
      {'userId': opponentId, 'seat': 1, 'connected': true},
    ],
    'createdAt': '2026-10-20T10:00:00.000Z',
    'startedAt': '2026-10-20T10:00:01.000Z',
    'completedAt': '2026-10-20T10:05:00.000Z',
    ...?overrides,
  };
}

void main() {
  group('PlayerProfile.fromJson', () {
    test('parses every public field', () {
      final profile = PlayerProfile.fromJson(_profileJson());

      expect(profile.id, opponentId);
      expect(profile.username, 'ada_l');
      expect(profile.displayName, 'Ada Lovelace');
      expect(profile.gamesPlayed, 10);
      expect(profile.wins, 6);
      expect(profile.losses, 3);
      expect(profile.draws, 1);
    });

    test('keeps a null display name null and falls back to the username', () {
      final profile = PlayerProfile.fromJson(
        _profileJson(overrides: {'displayName': null}),
      );

      expect(profile.displayName, isNull);
      expect(profile.displayLabel, 'ada_l');
    });

    test('treats a blank display name as unset', () {
      final profile = PlayerProfile.fromJson(
        _profileJson(overrides: {'displayName': '   '}),
      );

      expect(profile.displayLabel, 'ada_l');
    });

    test('trims a display name', () {
      final profile = PlayerProfile.fromJson(
        _profileJson(overrides: {'displayName': '  Ada  '}),
      );

      expect(profile.displayLabel, 'Ada');
    });

    test('accepts whole numbers that arrive as doubles', () {
      final profile = PlayerProfile.fromJson(
        _profileJson(overrides: {'wins': 6.0, 'gamesPlayed': 10.0}),
      );

      expect(profile.wins, 6);
      expect(profile.gamesPlayed, 10);
    });

    test(
      'ignores anything the contract does not include (never surfaces it)',
      () {
        final profile = PlayerProfile.fromJson(
          _profileJson(
            overrides: {
              'email': 'ada@example.com',
              'phoneNumber': '+23270000000',
              'dateOfBirth': '1990-01-01',
              'role': 'ADMIN',
              'walletBalance': '1000',
            },
          ),
        );

        // The model has no field for any of them, so there is nothing to show.
        expect(
          [
            profile.id,
            profile.username,
            profile.displayName,
            '${profile.gamesPlayed}',
          ].join(' '),
          isNot(contains('ada@example.com')),
        );
      },
    );

    test('never defaults a missing statistic to zero', () {
      for (final key in ['gamesPlayed', 'wins', 'losses', 'draws']) {
        final json = _profileJson()..remove(key);
        expect(
          () => PlayerProfile.fromJson(json),
          throwsFormatException,
          reason: 'a missing "$key" must be an error, not 0',
        );
      }
    });

    test('rejects malformed values', () {
      expect(
        () => PlayerProfile.fromJson(_profileJson(overrides: {'wins': -1})),
        throwsFormatException,
      );
      expect(
        () => PlayerProfile.fromJson(_profileJson(overrides: {'wins': 1.5})),
        throwsFormatException,
      );
      expect(
        () => PlayerProfile.fromJson(_profileJson(overrides: {'wins': '6'})),
        throwsFormatException,
      );
      expect(
        () => PlayerProfile.fromJson(_profileJson(overrides: {'id': null})),
        throwsFormatException,
      );
      expect(
        () => PlayerProfile.fromJson(_profileJson(overrides: {'username': ''})),
        throwsFormatException,
      );
      expect(
        () =>
            PlayerProfile.fromJson(_profileJson(overrides: {'displayName': 5})),
        throwsFormatException,
      );
    });
  });

  group('PlayerSummary.fromJson', () {
    test('parses id, username and display name', () {
      final summary = PlayerSummary.fromJson({
        'id': opponentId,
        'username': 'ada_l',
        'displayName': null,
      });

      expect(summary.id, opponentId);
      expect(summary.displayLabel, 'ada_l');
    });

    test('requires an id and a username', () {
      expect(
        () => PlayerSummary.fromJson({'username': 'x', 'displayName': null}),
        throwsFormatException,
      );
    });
  });

  group('MatchHistoryEntry.fromJson', () {
    test('parses the fields the history needs and ignores the game state', () {
      final entry = MatchHistoryEntry.fromJson(_matchJson());

      expect(entry.id, 'match-1');
      expect(entry.gameId, 'tic_tac_toe');
      expect(entry.status, 'COMPLETED');
      expect(entry.winnerUserId, myId);
      expect(entry.resultIsDraw, isFalse);
      expect(entry.terminationReason, isNull);
      expect(entry.playerUserIds, [myId, opponentId]);
      expect(entry.createdAt, DateTime.utc(2026, 10, 20, 10));
      expect(entry.completedAt, DateTime.utc(2026, 10, 20, 10, 5));
      expect(entry.when, entry.completedAt);
    });

    test(
      'falls back to the creation time for a match that has not finished',
      () {
        final entry = MatchHistoryEntry.fromJson(
          _matchJson(
            overrides: {
              'status': 'ACTIVE',
              'completedAt': null,
              'winnerUserId': null,
            },
          ),
        );

        expect(entry.completedAt, isNull);
        expect(entry.when, entry.createdAt);
      },
    );

    test('rejects a malformed match', () {
      expect(
        () => MatchHistoryEntry.fromJson(
          _matchJson(overrides: {'players': null}),
        ),
        throwsFormatException,
      );
      expect(
        () => MatchHistoryEntry.fromJson(
          _matchJson(
            overrides: {
              'players': [
                {'seat': 0},
              ],
            },
          ),
        ),
        throwsFormatException,
      );
      expect(
        () => MatchHistoryEntry.fromJson(
          _matchJson(overrides: {'createdAt': 'not a date'}),
        ),
        throwsFormatException,
      );
      expect(
        () => MatchHistoryEntry.fromJson(
          _matchJson(overrides: {'resultIsDraw': 'no'}),
        ),
        throwsFormatException,
      );
    });
  });

  group('MatchHistoryPage.fromJson', () {
    test('parses items and the next cursor', () {
      final page = MatchHistoryPage.fromJson({
        'items': [
          _matchJson(),
          _matchJson(overrides: {'id': 'match-2'}),
        ],
        'nextCursor': 'match-2',
      });

      expect(page.items.map((m) => m.id), ['match-1', 'match-2']);
      expect(page.nextCursor, 'match-2');
    });

    test('a null cursor means the last page', () {
      final page = MatchHistoryPage.fromJson({'items': [], 'nextCursor': null});

      expect(page.items, isEmpty);
      expect(page.nextCursor, isNull);
    });

    test('requires the items list', () {
      expect(
        () => MatchHistoryPage.fromJson({'nextCursor': null}),
        throwsFormatException,
      );
    });
  });

  group('describeMatchResult (the stored result is the only source)', () {
    MatchResultView describe(MatchHistoryEntry m) =>
        describeMatchResult(m, myId);

    test('a completed match won by the viewer is a win', () {
      final view = describe(buildMatch(id: 'm', winnerUserId: myId));

      expect(view.outcome, MatchOutcome.won);
      expect(view.label, 'Won');
    });

    test('a completed match won by the opponent is a loss', () {
      final view = describe(buildMatch(id: 'm', winnerUserId: opponentId));

      expect(view.outcome, MatchOutcome.lost);
      expect(view.label, 'Lost');
    });

    test('an explicit draw is a draw', () {
      final view = describe(buildMatch(id: 'm', resultIsDraw: true));

      expect(view.outcome, MatchOutcome.draw);
      expect(view.label, 'Draw');
    });

    test('says how it ended when the server says so', () {
      expect(
        describe(
          buildMatch(
            id: 'm',
            winnerUserId: myId,
            terminationReason: 'RESIGNATION',
          ),
        ).detail,
        'Opponent resigned.',
      );
      expect(
        describe(
          buildMatch(
            id: 'm',
            winnerUserId: opponentId,
            terminationReason: 'RESIGNATION',
          ),
        ).detail,
        'You resigned.',
      );
      expect(
        describe(
          buildMatch(
            id: 'm',
            winnerUserId: myId,
            terminationReason: 'TURN_TIMEOUT',
          ),
        ).detail,
        'Opponent ran out of time.',
      );
      expect(
        describe(
          buildMatch(
            id: 'm',
            winnerUserId: opponentId,
            terminationReason: 'TURN_TIMEOUT',
          ),
        ).detail,
        'You ran out of time.',
      );
      expect(
        describe(
          buildMatch(
            id: 'm',
            resultIsDraw: true,
            terminationReason: 'DRAW_AGREED',
          ),
        ).detail,
        'Draw agreed.',
      );
    });

    test(
      'an abandoned match is never a win or a loss, even with a winner stored',
      () {
        final view = describe(
          buildMatch(
            id: 'm',
            status: 'ABANDONED',
            winnerUserId: myId,
            terminationReason: 'ABANDONED_DISCONNECT',
          ),
        );

        expect(view.outcome, MatchOutcome.abandoned);
        expect(view.label, 'Abandoned');
      },
    );

    test('cancelled and expired matches are cancelled', () {
      final cancelled = describe(
        buildMatch(
          id: 'm',
          status: 'CANCELLED',
          terminationReason: 'WAITING_TIMEOUT',
        ),
      );
      final expired = describe(buildMatch(id: 'm', status: 'EXPIRED'));

      expect(cancelled.outcome, MatchOutcome.cancelled);
      expect(cancelled.detail, 'The match never started.');
      expect(expired.outcome, MatchOutcome.cancelled);
    });

    test('matches that have not finished are in progress, with no result', () {
      for (final status in ['WAITING', 'READY', 'ACTIVE']) {
        final view = describe(
          buildMatch(id: 'm', status: status, winnerUserId: myId),
        );
        expect(view.outcome, MatchOutcome.inProgress, reason: status);
      }
    });

    test(
      'an inconsistent completed match is "result not recorded", not guessed',
      () {
        final cases = <String, MatchHistoryEntry>{
          'no winner, not a draw': buildMatch(id: 'm'),
          'a draw that also names a winner': buildMatch(
            id: 'm',
            resultIsDraw: true,
            winnerUserId: myId,
          ),
          'a winner who was not a player': buildMatch(
            id: 'm',
            winnerUserId: otherOpponentId,
          ),
          'the viewer was not a player': buildMatch(
            id: 'm',
            winnerUserId: opponentId,
            players: [opponentId, otherOpponentId],
          ),
        };

        cases.forEach((name, match) {
          final view = describe(match);
          expect(view.outcome, MatchOutcome.unrecorded, reason: name);
          expect(view.label, 'Result not recorded', reason: name);
        });
      },
    );

    test('an unknown status is unknown rather than a result', () {
      final view = describe(buildMatch(id: 'm', status: 'SOMETHING_NEW'));

      expect(view.outcome, MatchOutcome.unrecorded);
    });
  });

  group('small formatters', () {
    test('prettyGameName', () {
      expect(prettyGameName('tic_tac_toe'), 'Tic Tac Toe');
      expect(prettyGameName('dice'), 'Dice');
      expect(prettyGameName('_'), '_');
    });

    test('formatShortDate uses the parts it is given', () {
      expect(formatShortDate(DateTime(2026, 10, 26)), '26 Oct 2026');
      expect(formatShortDate(DateTime(2027, 1, 3)), '3 Jan 2027');
    });

    test('isValidUserId accepts UUIDs and nothing else', () {
      expect(isValidUserId(myId), isTrue);
      expect(isValidUserId(myId.toUpperCase()), isTrue);
      expect(isValidUserId('user-1'), isFalse);
      expect(isValidUserId(''), isFalse);
      expect(isValidUserId('$myId/extra'), isFalse);
      expect(isValidUserId('../wallet'), isFalse);
    });
  });
}
