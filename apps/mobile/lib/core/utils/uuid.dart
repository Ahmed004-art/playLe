import 'dart:math';

final Random _random = Random.secure();

/// A real RFC 4122 v4 UUID, generated locally with no new dependency.
/// Needed because the backend validates `MatchCommand.id`
/// (`SubmitCommandDto.commandId`) with `class-validator`'s `@IsUUID()` —
/// unlike the plain idempotency-key strings used elsewhere (e.g.
/// `core/wallet/wallet_repository.dart`), this one must be a real UUID.
String generateUuidV4() {
  final bytes = List<int>.generate(16, (_) => _random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10

  String hex(int start, int end) => bytes
      .sublist(start, end)
      .map((b) => b.toRadixString(16).padLeft(2, '0'))
      .join();

  return '${hex(0, 4)}-${hex(4, 6)}-${hex(6, 8)}-${hex(8, 10)}-${hex(10, 16)}';
}
