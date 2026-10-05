import 'wallet_models.dart';

/// Mirrors the `AuthState` pattern (`core/auth/auth_state.dart`): a sealed
/// class so every screen handles every state explicitly instead of
/// juggling separate loading/error booleans.
sealed class WalletState {
  const WalletState();
}

class WalletLoading extends WalletState {
  const WalletLoading();
}

class WalletLoaded extends WalletState {
  const WalletLoaded({required this.wallet, required this.transactions});

  final Wallet wallet;
  final List<LedgerEntry> transactions;
}

class WalletLoadError extends WalletState {
  const WalletLoadError(this.message);

  final String message;
}
