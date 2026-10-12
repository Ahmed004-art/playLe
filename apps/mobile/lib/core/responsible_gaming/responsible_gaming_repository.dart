import '../network/api_client.dart';
import 'responsible_gaming_models.dart';

/// Self-service responsible-gaming controls — mirrors
/// `apps/api/src/eligibility/responsible-gaming.controller.ts`. There is
/// deliberately no method here (or anywhere in the API) to lift a
/// self-exclusion — see `RestrictionInfo`'s doc comment and
/// docs/decisions/ADR-021-eligibility-and-responsible-gaming.md.
abstract class ResponsibleGamingRepository {
  Future<List<RestrictionInfo>> getStatus();

  /// Permanently self-excludes from real-money play. Cannot be undone
  /// through this app — there is no lift endpoint anywhere.
  Future<RestrictionInfo> selfExclude();

  Future<RestrictionInfo> startCoolingOff(int durationMinutes);

  /// [limitMinor] is a decimal minor-units string (never a double),
  /// same convention as every other amount in this app.
  Future<RestrictionInfo> setDepositLimit(String limitMinor);

  Future<RestrictionInfo> setStakeLimit(String limitMinor);

  /// Recorded/visible, but not yet enforced at settlement — see
  /// `RestrictionInfo`'s doc comment.
  Future<RestrictionInfo> setLossLimit(String limitMinor);
}

class HttpResponsibleGamingRepository implements ResponsibleGamingRepository {
  const HttpResponsibleGamingRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<List<RestrictionInfo>> getStatus() async {
    final response = await apiClient.get<List<dynamic>>(
      '/auth/responsible-gaming/status',
    );
    return response.data!
        .cast<Map<String, dynamic>>()
        .map(RestrictionInfo.fromJson)
        .toList();
  }

  @override
  Future<RestrictionInfo> selfExclude() async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/auth/responsible-gaming/self-exclude',
    );
    return RestrictionInfo.fromJson(response.data!);
  }

  @override
  Future<RestrictionInfo> startCoolingOff(int durationMinutes) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/auth/responsible-gaming/cooling-off',
      data: {'durationMinutes': durationMinutes},
    );
    return RestrictionInfo.fromJson(response.data!);
  }

  @override
  Future<RestrictionInfo> setDepositLimit(String limitMinor) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/auth/responsible-gaming/deposit-limit',
      data: {'limitMinor': limitMinor},
    );
    return RestrictionInfo.fromJson(response.data!);
  }

  @override
  Future<RestrictionInfo> setStakeLimit(String limitMinor) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/auth/responsible-gaming/stake-limit',
      data: {'limitMinor': limitMinor},
    );
    return RestrictionInfo.fromJson(response.data!);
  }

  @override
  Future<RestrictionInfo> setLossLimit(String limitMinor) async {
    final response = await apiClient.post<Map<String, dynamic>>(
      '/auth/responsible-gaming/loss-limit',
      data: {'limitMinor': limitMinor},
    );
    return RestrictionInfo.fromJson(response.data!);
  }
}
