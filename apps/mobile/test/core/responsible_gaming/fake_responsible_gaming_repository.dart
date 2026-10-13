import 'package:playle_mobile/core/errors/app_exception.dart';
import 'package:playle_mobile/core/responsible_gaming/responsible_gaming_models.dart';
import 'package:playle_mobile/core/responsible_gaming/responsible_gaming_repository.dart';

const testUsage = UsageInfo(
  windowHours: 24,
  stakeHeldMinor: '0',
  lossMinor: '0',
  depositedMinor: '0',
);

/// A controllable [ResponsibleGamingRepository] fake for testing
/// [ResponsibleGamingController] and the responsible-gaming screen
/// without a real network dependency — mirrors
/// `test/core/wallet/fake_wallet_repository.dart`.
class FakeResponsibleGamingRepository implements ResponsibleGamingRepository {
  List<RestrictionInfo> restrictionsToReturn = const [];
  UsageInfo usageToReturn = testUsage;
  AppException? nextError;
  int selfExcludeCallCount = 0;
  final List<int> coolingOffCallsMinutes = [];
  final List<String> setDepositLimitCalls = [];
  final List<String> setStakeLimitCalls = [];
  final List<String> setLossLimitCalls = [];

  @override
  Future<List<RestrictionInfo>> getStatus() async {
    if (nextError != null) throw nextError!;
    return restrictionsToReturn;
  }

  @override
  Future<UsageInfo> getUsage() async {
    if (nextError != null) throw nextError!;
    return usageToReturn;
  }

  @override
  Future<RestrictionInfo> selfExclude() async {
    if (nextError != null) throw nextError!;
    selfExcludeCallCount++;
    final restriction = RestrictionInfo(
      id: 'restriction-self-exclude',
      type: 'SELF_EXCLUSION',
      status: 'ACTIVE',
      config: const {},
      startsAt: DateTime.now(),
      createdAt: DateTime.now(),
    );
    restrictionsToReturn = [...restrictionsToReturn, restriction];
    return restriction;
  }

  @override
  Future<RestrictionInfo> startCoolingOff(int durationMinutes) async {
    if (nextError != null) throw nextError!;
    coolingOffCallsMinutes.add(durationMinutes);
    return RestrictionInfo(
      id: 'restriction-cooling-off',
      type: 'COOLING_OFF',
      status: 'ACTIVE',
      config: const {},
      startsAt: DateTime.now(),
      createdAt: DateTime.now(),
      endsAt: DateTime.now().add(Duration(minutes: durationMinutes)),
    );
  }

  @override
  Future<RestrictionInfo> setDepositLimit(String limitMinor) async {
    if (nextError != null) throw nextError!;
    setDepositLimitCalls.add(limitMinor);
    return _limitRestriction('DEPOSIT_LIMIT', limitMinor);
  }

  @override
  Future<RestrictionInfo> setStakeLimit(String limitMinor) async {
    if (nextError != null) throw nextError!;
    setStakeLimitCalls.add(limitMinor);
    return _limitRestriction('STAKE_LIMIT', limitMinor);
  }

  @override
  Future<RestrictionInfo> setLossLimit(String limitMinor) async {
    if (nextError != null) throw nextError!;
    setLossLimitCalls.add(limitMinor);
    return _limitRestriction('LOSS_LIMIT', limitMinor);
  }

  RestrictionInfo _limitRestriction(String type, String limitMinor) {
    return RestrictionInfo(
      id: 'restriction-$type',
      type: type,
      status: 'ACTIVE',
      config: {'limitMinor': limitMinor},
      startsAt: DateTime.now(),
      createdAt: DateTime.now(),
    );
  }
}
