import 'social_models.dart';

sealed class PlayerProfileState {
  const PlayerProfileState();
}

class PlayerProfileLoading extends PlayerProfileState {
  const PlayerProfileLoading();
}

class PlayerProfileLoaded extends PlayerProfileState {
  const PlayerProfileLoaded(this.profile);
  final PlayerProfile profile;
}

/// The player does not exist or may not be seen (the API cannot say which),
/// or the id in the route was not a valid id at all.
class PlayerProfileNotFound extends PlayerProfileState {
  const PlayerProfileNotFound();
}

/// The session is no longer valid; the user must sign in again.
class PlayerProfileUnauthorized extends PlayerProfileState {
  const PlayerProfileUnauthorized();
}

class PlayerProfileError extends PlayerProfileState {
  const PlayerProfileError(this.message);
  final String message;
}
