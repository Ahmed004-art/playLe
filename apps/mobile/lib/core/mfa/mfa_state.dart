/// Mirrors the `AuthState`/`WalletState` pattern: a sealed class so every
/// screen handles every state explicitly.
sealed class MfaState {
  const MfaState();
}

class MfaLoading extends MfaState {
  const MfaLoading();
}

class MfaLoaded extends MfaState {
  const MfaLoaded(this.enabled);

  final bool enabled;
}

class MfaLoadError extends MfaState {
  const MfaLoadError(this.message);

  final String message;
}
