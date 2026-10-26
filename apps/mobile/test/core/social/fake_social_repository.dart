import 'dart:async';

import 'package:playle_mobile/core/social/social_models.dart';
import 'package:playle_mobile/core/social/social_repository.dart';

// Well-formed ids: the app rejects a route id that is not a UUID before it
// ever asks the server, so test ids must be real UUIDs.
const myId = '11111111-1111-4111-8111-111111111111';
const opponentId = '22222222-2222-4222-8222-222222222222';
const otherOpponentId = '33333333-3333-4333-8333-333333333333';

PlayerProfile buildProfile({
  String id = opponentId,
  String username = 'ada_l',
  String? displayName = 'Ada Lovelace',
  int gamesPlayed = 10,
  int wins = 6,
  int losses = 3,
  int draws = 1,
}) {
  return PlayerProfile(
    id: id,
    username: username,
    displayName: displayName,
    gamesPlayed: gamesPlayed,
    wins: wins,
    losses: losses,
    draws: draws,
  );
}

MatchHistoryEntry buildMatch({
  required String id,
  String gameId = 'tic_tac_toe',
  String status = 'COMPLETED',
  String? winnerUserId,
  bool resultIsDraw = false,
  String? terminationReason,
  List<String>? players,
  DateTime? createdAt,
  DateTime? completedAt,
}) {
  return MatchHistoryEntry(
    id: id,
    gameId: gameId,
    status: status,
    winnerUserId: winnerUserId,
    resultIsDraw: resultIsDraw,
    terminationReason: terminationReason,
    playerUserIds: players ?? [myId, opponentId],
    createdAt: createdAt ?? DateTime.utc(2026, 10, 20, 12),
    completedAt: completedAt,
  );
}

/// A controllable [SocialRepository] for controller and widget tests.
class FakeSocialRepository implements SocialRepository {
  PlayerProfile? profileToReturn;
  Object? profileError;

  /// When set, [getProfile] waits for it, so a test can hold a request in
  /// flight (to prove nothing is fetched twice, or a late reply is ignored).
  Completer<void>? profileGate;
  int profileCalls = 0;
  final List<String> profileRequests = [];

  List<PlayerSummary> summariesToReturn = [];
  Object? summariesError;
  final List<List<String>> summaryRequests = [];

  /// Pages returned by successive [getMatchHistory] calls (the first call gets
  /// the first page, and so on). Past the end an empty last page is returned.
  List<MatchHistoryPage> pages = [];
  final Map<int, Object> historyErrorsByCall = {};
  final List<String?> historyCursors = [];
  int historyCalls = 0;

  @override
  Future<PlayerProfile> getProfile(String userId) async {
    profileCalls++;
    profileRequests.add(userId);
    final gate = profileGate;
    if (gate != null) {
      await gate.future;
    }
    final error = profileError;
    if (error != null) {
      throw error;
    }
    return profileToReturn ?? buildProfile(id: userId);
  }

  @override
  Future<List<PlayerSummary>> getSummaries(List<String> userIds) async {
    summaryRequests.add(List<String>.of(userIds));
    final error = summariesError;
    if (error != null) {
      throw error;
    }
    return summariesToReturn;
  }

  @override
  Future<MatchHistoryPage> getMatchHistory({
    String? cursor,
    int limit = 20,
  }) async {
    final call = historyCalls++;
    historyCursors.add(cursor);
    final error = historyErrorsByCall[call];
    if (error != null) {
      throw error;
    }
    if (call < pages.length) {
      return pages[call];
    }
    return const MatchHistoryPage(items: [], nextCursor: null);
  }
}
