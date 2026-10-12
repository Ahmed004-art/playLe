import '../network/api_client.dart';
import 'session_models.dart';

/// Lists/revokes the authenticated user's own active sessions — mirrors
/// `apps/api/src/auth/sessions.controller.ts`.
abstract class SessionsRepository {
  Future<List<SessionInfo>> list();

  /// Ends one specific session. Revoking a session that doesn't belong
  /// to the caller 404s server-side — this app never sees another
  /// user's session id to revoke in the first place.
  Future<void> revoke(String id);

  /// Ends every active session, including the one making this request.
  Future<void> revokeAll();
}

class HttpSessionsRepository implements SessionsRepository {
  const HttpSessionsRepository({required this.apiClient});

  final ApiClient apiClient;

  @override
  Future<List<SessionInfo>> list() async {
    final response = await apiClient.get<List<dynamic>>('/auth/sessions');
    return response.data!
        .cast<Map<String, dynamic>>()
        .map(SessionInfo.fromJson)
        .toList();
  }

  @override
  Future<void> revoke(String id) async {
    await apiClient.post<void>('/auth/sessions/$id/revoke');
  }

  @override
  Future<void> revokeAll() async {
    await apiClient.post<void>('/auth/sessions/revoke-all');
  }
}
