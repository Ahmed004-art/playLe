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

  bool get isAdmin => role == 'ADMIN';
}
