import { ApiProperty } from '@nestjs/swagger';
import { ChallengeStatus } from '@prisma/client';
import type { Challenge } from '@prisma/client';

export class ChallengeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() gameId!: string;
  @ApiProperty() challengerId!: string;
  @ApiProperty() opponentId!: string;
  @ApiProperty({ enum: ChallengeStatus }) status!: ChallengeStatus;
  @ApiProperty({ nullable: true, type: String }) matchId!: string | null;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty() createdAt!: Date;
}

export function toChallengeResponse(
  challenge: Challenge,
): ChallengeResponseDto {
  return {
    id: challenge.id,
    gameId: challenge.gameId,
    challengerId: challenge.challengerId,
    opponentId: challenge.opponentId,
    status: challenge.status,
    matchId: challenge.matchId,
    expiresAt: challenge.expiresAt,
    createdAt: challenge.createdAt,
  };
}
