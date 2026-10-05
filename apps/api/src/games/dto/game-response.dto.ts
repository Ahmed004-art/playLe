import { ApiProperty } from '@nestjs/swagger';
import type { Game } from '@prisma/client';

export class GameResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() description!: string;
  @ApiProperty() minPlayers!: number;
  @ApiProperty() maxPlayers!: number;
  @ApiProperty() version!: number;
  @ApiProperty({ nullable: true, type: String }) iconKey!: string | null;
}

export function toGameResponse(game: Game): GameResponseDto {
  return {
    id: game.id,
    displayName: game.displayName,
    description: game.description,
    minPlayers: game.minPlayers,
    maxPlayers: game.maxPlayers,
    version: game.version,
    iconKey: game.iconKey,
  };
}
