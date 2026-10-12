/// Mirrors the API's `MfaEnrollResponseDto` (`POST /auth/mfa/enroll`).
/// Enforces nothing until confirmed with a real code — see
/// `MfaRepository.confirm`.
class MfaEnrollment {
  const MfaEnrollment({required this.secret, required this.otpauthUri});

  factory MfaEnrollment.fromJson(Map<String, dynamic> json) {
    return MfaEnrollment(
      secret: json['secret'] as String,
      otpauthUri: json['otpauthUri'] as String,
    );
  }

  /// Base32 TOTP secret — shown as selectable text so manual entry into
  /// an authenticator app always works, even without QR rendering.
  final String secret;

  /// `otpauth://` URI — rendered as a QR code for the common case of
  /// scanning rather than typing.
  final String otpauthUri;
}
