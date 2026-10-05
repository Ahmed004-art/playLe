/// Mirrors the API's `GameResponseDto`.
class GameInfo {
  const GameInfo({
    required this.id,
    required this.displayName,
    required this.description,
    required this.minPlayers,
    required this.maxPlayers,
    this.iconKey,
  });

  factory GameInfo.fromJson(Map<String, dynamic> json) {
    return GameInfo(
      id: json['id'] as String,
      displayName: json['displayName'] as String,
      description: json['description'] as String,
      minPlayers: json['minPlayers'] as int,
      maxPlayers: json['maxPlayers'] as int,
      iconKey: json['iconKey'] as String?,
    );
  }

  final String id;
  final String displayName;
  final String description;
  final int minPlayers;
  final int maxPlayers;
  final String? iconKey;
}
