import 'package:flutter/foundation.dart';

import '../logging/app_logger.dart';
import 'player_profile_state.dart';
import 'social_errors.dart';
import 'social_models.dart';
import 'social_repository.dart';

/// Owns one player's profile for one screen. Created per profile screen (it is
/// bound to a [userId]) and disposed with it.
///
/// - **No duplicate requests:** [load] does nothing while a request is already
///   in flight, so a rebuild, a double tap on Retry, or a repeated
///   `initState` can never double-fetch.
/// - **Safe on dispose:** a response that arrives after [dispose] is dropped
///   and never touches the (dead) notifier.
/// - **No pointless requests:** an id that is not a valid user id is "not
///   found" immediately, without asking the server.
class PlayerProfileController extends ChangeNotifier {
  PlayerProfileController(this._repository, {required this.userId});

  final SocialRepository _repository;
  final String userId;

  PlayerProfileState _state = const PlayerProfileLoading();
  PlayerProfileState get state => _state;

  bool _loading = false;
  bool _disposed = false;

  Future<void> load() async {
    if (_loading) {
      return;
    }
    if (!isValidUserId(userId)) {
      _setState(const PlayerProfileNotFound());
      return;
    }

    _loading = true;
    _setState(const PlayerProfileLoading());
    try {
      final profile = await _repository.getProfile(userId);
      _setState(PlayerProfileLoaded(profile));
    } catch (e) {
      AppLogger.instance.warning('Failed to load profile: $e');
      switch (classifyFailure(e)) {
        case SocialFailureKind.unauthorized:
          _setState(const PlayerProfileUnauthorized());
        case SocialFailureKind.notFound:
          _setState(const PlayerProfileNotFound());
        case SocialFailureKind.other:
          _setState(PlayerProfileError(friendlyFailureMessage(e)));
      }
    } finally {
      _loading = false;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

  void _setState(PlayerProfileState next) {
    if (_disposed) {
      return;
    }
    _state = next;
    notifyListeners();
  }
}
