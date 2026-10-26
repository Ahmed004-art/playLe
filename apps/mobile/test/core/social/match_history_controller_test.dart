import 'package:flutter_test/flutter_test.dart';
import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/games/game_models.dart';
import 'package:playle_mobile/core/social/match_history_controller.dart';
import 'package:playle_mobile/core/social/match_history_state.dart';
import 'package:playle_mobile/core/social/social_models.dart';

import '../games/fake_games_repository.dart';
import 'fake_social_repository.dart';

MatchHistoryController _controller(
  FakeSocialRepository social, {
  FakeGamesRepository? games,
  int pageSize = 20,
}) {
  return MatchHistoryController(
    social,
    games ?? FakeGamesRepository(),
    myUserId: myId,
    pageSize: pageSize,
  );
}

MatchHistoryLoaded _loaded(MatchHistoryController c) =>
    c.state as MatchHistoryLoaded;

void main() {
  group('MatchHistoryController', () {
    test('an empty history is loaded with no items and no more pages', () async {
      final social = FakeSocialRepository();
      final controller = _controller(social);
      addTearDown(controller.dispose);

      await controller.load();

      final state = _loaded(controller);
      expect(state.items, isEmpty);
      expect(state.hasMore, isFalse);
      expect(social.summaryRequests, isEmpty);
    });

    test('shows the real stored fields: result, game, opponent and date', () async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [
              buildMatch(
                id: 'm1',
                winnerUserId: myId,
                completedAt: DateTime.utc(2026, 10, 21, 9),
              ),
            ],
            nextCursor: null,
          ),
        ]
        ..summariesToReturn = const [
          PlayerSummary(id: opponentId, username: 'ada_l', displayName: 'Ada'),
        ];
      final controller = _controller(social);
      addTearDown(controller.dispose);

      await controller.load();

      final item = _loaded(controller).items.single;
      expect(item.result.outcome, MatchOutcome.won);
      expect(item.gameLabel, 'Tic-Tac-Toe'); // from the games catalog
      expect(item.opponentLabel, 'Ada');
      expect(item.opponentUserId, opponentId);
      expect(item.when, DateTime.utc(2026, 10, 21, 9));
    });

    test('resolves every opponent with ONE summaries request, not one per match', () async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [
              buildMatch(id: 'm1', winnerUserId: myId),
              buildMatch(id: 'm2', winnerUserId: opponentId),
              buildMatch(
                id: 'm3',
                resultIsDraw: true,
                players: [myId, otherOpponentId],
              ),
              buildMatch(id: 'm4', winnerUserId: myId),
            ],
            nextCursor: null,
          ),
        ];
      final controller = _controller(social);
      addTearDown(controller.dispose);

      await controller.load();

      expect(social.summaryRequests, hasLength(1));
      expect(social.summaryRequests.single.toSet(), {opponentId, otherOpponentId});
      // Never asks about the viewer.
      expect(social.summaryRequests.single, isNot(contains(myId)));
    });

    test('a player the API did not reveal is shown as unavailable, never invented', () async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [buildMatch(id: 'm1', winnerUserId: myId)],
            nextCursor: null,
          ),
        ]
        ..summariesToReturn = const []; // hidden: absent from the response
      final controller = _controller(social);
      addTearDown(controller.dispose);

      await controller.load();

      expect(_loaded(controller).items.single.opponentLabel, 'Player unavailable');
    });

    test('a failure to resolve names or games never fails the history', () async {
      final social = FakeSocialRepository()
        ..summariesError = const NetworkException('names down')
        ..pages = [
          MatchHistoryPage(
            items: [buildMatch(id: 'm1', gameId: 'dice', winnerUserId: myId)],
            nextCursor: null,
          ),
        ];
      final games = _ThrowingGamesRepository();
      final controller = _controller(social, games: games);
      addTearDown(controller.dispose);

      await controller.load();

      final item = _loaded(controller).items.single;
      expect(item.opponentLabel, 'Player unavailable');
      expect(item.gameLabel, 'Dice'); // readable fallback from the id
      expect(item.result.outcome, MatchOutcome.won);
    });

    test('maps abandoned, cancelled and in-progress matches by the real contract', () async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [
              buildMatch(id: 'a', status: 'ABANDONED', winnerUserId: myId),
              buildMatch(id: 'c', status: 'CANCELLED'),
              buildMatch(id: 'p', status: 'ACTIVE'),
              buildMatch(id: 'x'), // completed, no winner, not a draw
            ],
            nextCursor: null,
          ),
        ];
      final controller = _controller(social);
      addTearDown(controller.dispose);

      await controller.load();

      expect(
        _loaded(controller).items.map((i) => i.result.outcome).toList(),
        [
          MatchOutcome.abandoned,
          MatchOutcome.cancelled,
          MatchOutcome.inProgress,
          MatchOutcome.unrecorded,
        ],
      );
    });

    test('a match with several opponents is not linked to one profile', () async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [
              buildMatch(
                id: 'g',
                players: [myId, opponentId, otherOpponentId],
              ),
            ],
            nextCursor: null,
          ),
        ];
      final controller = _controller(social);
      addTearDown(controller.dispose);

      await controller.load();

      final item = _loaded(controller).items.single;
      expect(item.opponentUserId, isNull);
      expect(item.opponentLabel, '2 opponents');
    });

    test('loads further pages by cursor, appends them, and stops at the end', () async {
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
      final controller = _controller(social, pageSize: 1);
      addTearDown(controller.dispose);

      await controller.load();
      expect(_loaded(controller).hasMore, isTrue);

      await controller.loadMore();

      final state = _loaded(controller);
      expect(state.items.map((i) => i.entry.id), ['m1', 'm2']);
      expect(state.hasMore, isFalse);
      expect(social.historyCursors, [null, 'm1']);

      await controller.loadMore(); // nothing left: no request
      expect(social.historyCalls, 2);
    });

    test('names already known are not asked for again on the next page', () async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [buildMatch(id: 'm1', winnerUserId: myId)],
            nextCursor: 'm1',
          ),
          MatchHistoryPage(
            items: [buildMatch(id: 'm2', winnerUserId: myId)],
            nextCursor: null,
          ),
        ]
        ..summariesToReturn = const [
          PlayerSummary(id: opponentId, username: 'ada_l', displayName: null),
        ];
      final controller = _controller(social, pageSize: 1);
      addTearDown(controller.dispose);

      await controller.load();
      await controller.loadMore();

      expect(social.summaryRequests, hasLength(1));
    });

    test('never shows the same match twice if a page overlaps', () async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [buildMatch(id: 'm1', winnerUserId: myId)],
            nextCursor: 'm1',
          ),
          MatchHistoryPage(
            items: [
              buildMatch(id: 'm1', winnerUserId: myId),
              buildMatch(id: 'm2', winnerUserId: myId),
            ],
            nextCursor: null,
          ),
        ];
      final controller = _controller(social, pageSize: 2);
      addTearDown(controller.dispose);

      await controller.load();
      await controller.loadMore();

      expect(_loaded(controller).items.map((i) => i.entry.id), ['m1', 'm2']);
    });

    test('a failed next page keeps what is shown and can be retried', () async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [buildMatch(id: 'm1', winnerUserId: myId)],
            nextCursor: 'm1',
          ),
          MatchHistoryPage(
            items: [buildMatch(id: 'm2', winnerUserId: myId)],
            nextCursor: null,
          ),
        ]
        ..historyErrorsByCall[1] = const NetworkException('offline');
      final controller = _controller(social, pageSize: 1);
      addTearDown(controller.dispose);
      await controller.load();

      await controller.loadMore();
      var state = _loaded(controller);
      expect(state.items, hasLength(1));
      expect(state.loadMoreError, isNotNull);
      expect(state.hasMore, isTrue);

      // The failure on call index 1 is cleared by the next attempt: call 2
      // has no scripted page, so give it one by resetting the script.
      social.historyErrorsByCall.clear();
      social.pages = [
        social.pages[0],
        social.pages[1],
        social.pages[1],
      ];
      await controller.loadMore();

      state = _loaded(controller);
      expect(state.loadMoreError, isNull);
      expect(state.items.map((i) => i.entry.id), ['m1', 'm2']);
    });

    test('does not request the same next page twice at once', () async {
      final social = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [buildMatch(id: 'm1', winnerUserId: myId)],
            nextCursor: 'm1',
          ),
          MatchHistoryPage(items: const [], nextCursor: null),
        ];
      final controller = _controller(social, pageSize: 1);
      addTearDown(controller.dispose);
      await controller.load();

      await Future.wait([controller.loadMore(), controller.loadMore()]);

      expect(social.historyCalls, 2); // the first page + ONE next page
    });

    test('a first-page failure is a retryable error, and retry works', () async {
      final social = FakeSocialRepository()
        ..historyErrorsByCall[0] = const NetworkException('offline');
      final controller = _controller(social);
      addTearDown(controller.dispose);

      await controller.load();
      expect(controller.state, isA<MatchHistoryError>());
      expect(
        (controller.state as MatchHistoryError).message,
        'Could not reach PlayLe. Check your connection and try again.',
      );

      await controller.load();
      expect(controller.state, isA<MatchHistoryLoaded>());
    });

    test('a 401 is unauthorized (first page and later pages)', () async {
      final first = FakeSocialRepository()
        ..historyErrorsByCall[0] =
            const NetworkException('Unauthorized', statusCode: 401);
      final firstController = _controller(first);
      addTearDown(firstController.dispose);
      await firstController.load();
      expect(firstController.state, isA<MatchHistoryUnauthorized>());

      final later = FakeSocialRepository()
        ..pages = [
          MatchHistoryPage(
            items: [buildMatch(id: 'm1', winnerUserId: myId)],
            nextCursor: 'm1',
          ),
        ]
        ..historyErrorsByCall[1] =
            const NetworkException('Unauthorized', statusCode: 401);
      final laterController = _controller(later, pageSize: 1);
      addTearDown(laterController.dispose);
      await laterController.load();
      await laterController.loadMore();
      expect(laterController.state, isA<MatchHistoryUnauthorized>());
    });

    test('loadMore before the first page has loaded does nothing', () async {
      final social = FakeSocialRepository();
      final controller = _controller(social);
      addTearDown(controller.dispose);

      await controller.loadMore();

      expect(social.historyCalls, 0);
    });
  });
}

class _ThrowingGamesRepository extends FakeGamesRepository {
  @override
  Future<List<GameInfo>> listGames() async {
    throw const NetworkException('games down');
  }
}
