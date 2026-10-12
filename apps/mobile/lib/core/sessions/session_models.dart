/// Mirrors the API's `SessionResponseDto` — one active refresh-token
/// "session" for the authenticated user (see
/// `apps/api/src/auth/dto/session-response.dto.ts`). Extends the existing
/// rotating-refresh-token system rather than being a new primitive — see
/// docs/decisions/ADR-020-account-security.md.
class SessionInfo {
  const SessionInfo({
    required this.id,
    required this.familyId,
    required this.createdAt,
    required this.expiresAt,
    this.userAgent,
    this.ipAddress,
  });

  factory SessionInfo.fromJson(Map<String, dynamic> json) {
    return SessionInfo(
      id: json['id'] as String,
      familyId: json['familyId'] as String,
      userAgent: json['userAgent'] as String?,
      ipAddress: json['ipAddress'] as String?,
      createdAt: DateTime.parse(json['createdAt'] as String),
      expiresAt: DateTime.parse(json['expiresAt'] as String),
    );
  }

  final String id;
  final String familyId;
  final String? userAgent;
  final String? ipAddress;
  final DateTime createdAt;
  final DateTime expiresAt;
}
