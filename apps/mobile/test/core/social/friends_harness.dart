import 'dart:async';

import 'package:playle_mobile/core/challenges/challenge_models.dart';
import 'package:playle_mobile/core/social/friends_hub_controller.dart';

import '../challenges/fake_challenges_repository.dart';
import '../games/fake_games_repository.dart';
import 'fake_realtime.dart';
import 'fake_social_repository.dart';

/// Everything a [FriendsHubController] needs, as fakes, plus a record of the
/// challenges it created. Used by the controller tests and, through
/// [create], as the screen's controller factory in the widget tests.
class FriendsHarness {
  FriendsHarness({
    FakeSocialRepository? social,
    FakeGamesRepository? games,
    this.pageSize = 20,
  }) : social = social ?? FakeSocialRepository(),
       games = games ?? FakeGamesRepository() {
    ws = FakeWebSocketClient();
    realtime = FakeRealtime(ws);
  }

  final FakeSocialRepository social;
  final FakeGamesRepository games;
  final int pageSize;
  late final FakeWebSocketClient ws;
  late final FakeRealtime realtime;

  /// `(gameId, opponentUserId)` of every challenge created, in order.
  final List<({String gameId, String opponentId})> challenges = [];

  /// Makes the next challenge creation throw this.
  Object? challengeError;

  /// Holds challenge creation until completed (to test in-flight taps).
  Completer<void>? challengeGate;

  /// The last controller [create] built.
  FriendsHubController? lastHub;

  FriendsHubController create(String myUserId) {
    final hub = FriendsHubController(
      social: social,
      games: games,
      createChallenge: _createChallenge,
      webSocketClient: ws,
      realtimeConnectionManager: realtime,
      myUserId: myUserId,
      pageSize: pageSize,
    );
    lastHub = hub;
    return hub;
  }

  Future<ChallengeInfo> _createChallenge(
    String gameId,
    String opponentUserId,
  ) async {
    challenges.add((gameId: gameId, opponentId: opponentUserId));
    final gate = challengeGate;
    if (gate != null) {
      await gate.future;
    }
    final error = challengeError;
    if (error != null) {
      throw error;
    }
    return testChallenge;
  }
}
