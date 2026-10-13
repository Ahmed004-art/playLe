import 'responsible_gaming_models.dart';

sealed class ResponsibleGamingState {
  const ResponsibleGamingState();
}

class ResponsibleGamingLoading extends ResponsibleGamingState {
  const ResponsibleGamingLoading();
}

class ResponsibleGamingLoaded extends ResponsibleGamingState {
  const ResponsibleGamingLoaded(this.restrictions, this.usage);

  final List<RestrictionInfo> restrictions;

  /// The authenticated user's current rolling-window usage (Phase 8).
  final UsageInfo usage;

  bool get isSelfExcluded => restrictions.any(
    (r) => r.type == 'SELF_EXCLUSION' && r.status == 'ACTIVE',
  );
}

class ResponsibleGamingLoadError extends ResponsibleGamingState {
  const ResponsibleGamingLoadError(this.message);

  final String message;
}
