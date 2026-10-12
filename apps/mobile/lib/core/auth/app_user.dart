/// Mirrors the API's `UserResponseDto` — the safe, public-facing shape of
/// a user. Never includes a password or any token.
class AppUser {
  const AppUser({
    required this.id,
    required this.email,
    required this.username,
    required this.role,
    required this.status,
    this.phoneNumber,
    this.displayName,
    this.avatarUrl,
    this.emailVerifiedAt,
    this.phoneVerifiedAt,
  });

  factory AppUser.fromJson(Map<String, dynamic> json) {
    return AppUser(
      id: json['id'] as String,
      email: json['email'] as String,
      username: json['username'] as String,
      role: json['role'] as String,
      status: json['status'] as String,
      phoneNumber: json['phoneNumber'] as String?,
      displayName: json['displayName'] as String?,
      avatarUrl: json['avatarUrl'] as String?,
      emailVerifiedAt: json['emailVerifiedAt'] == null
          ? null
          : DateTime.parse(json['emailVerifiedAt'] as String),
      phoneVerifiedAt: json['phoneVerifiedAt'] == null
          ? null
          : DateTime.parse(json['phoneVerifiedAt'] as String),
    );
  }

  final String id;
  final String email;
  final String username;
  final String role;
  final String status;
  final String? phoneNumber;
  final String? displayName;
  final String? avatarUrl;
  final DateTime? emailVerifiedAt;
  final DateTime? phoneVerifiedAt;

  bool get isAdmin => role == 'ADMIN';
  bool get isEmailVerified => emailVerifiedAt != null;
  bool get isPhoneVerified => phoneVerifiedAt != null;
}
