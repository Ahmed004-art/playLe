import 'responsible_gaming_models.dart';

sealed class ResponsibleGamingState {
  const ResponsibleGamingState();
}

class ResponsibleGamingLoading extends ResponsibleGamingState {
  const ResponsibleGamingLoading();
}

class ResponsibleGamingLoaded extends ResponsibleGamingState {
  const ResponsibleGamingLoaded(this.restrictions);

  final List<RestrictionInfo> restrictions;

  bool get isSelfExcluded => restrictions.any(
    (r) => r.type == 'SELF_EXCLUSION' && r.status == 'ACTIVE',
  );
}

class ResponsibleGamingLoadError extends ResponsibleGamingState {
  const ResponsibleGamingLoadError(this.message);

  final String message;
}
