import 'package:flutter/foundation.dart';

import '../errors/app_exception.dart';
import 'game_models.dart';
import 'games_repository.dart';

sealed class GamesState {
  const GamesState();
}

class GamesLoading extends GamesState {
  const GamesLoading();
}

class GamesLoaded extends GamesState {
  const GamesLoaded(this.games);
  final List<GameInfo> games;
}

class GamesLoadError extends GamesState {
  const GamesLoadError(this.message);
  final String message;
}

/// Owns the game catalog list. Mirrors `core/wallet/wallet_controller.dart`'s
/// shape exactly.
class GamesController extends ChangeNotifier {
  GamesController(this._repository);

  final GamesRepository _repository;

  GamesState _state = const GamesLoading();
  GamesState get state => _state;

  Future<void> refresh() async {
    _setState(const GamesLoading());
    try {
      final games = await _repository.listGames();
      _setState(GamesLoaded(games));
    } catch (e) {
      _setState(
        GamesLoadError(e is AppException ? e.message : 'Failed to load games'),
      );
    }
  }

  void _setState(GamesState next) {
    _state = next;
    notifyListeners();
  }
}
