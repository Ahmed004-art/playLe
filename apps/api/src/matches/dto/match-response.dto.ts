import { ApiProperty } from '@nestjs/swagger';
import { MatchStatus, MatchTerminationReason } from '@prisma/client';
import type { Match, MatchPlayer } from '@prisma/client';

export class MatchPlayerResponseDto {
  @ApiProperty() userId!: string;
  @ApiProperty() seat!: number;
  @ApiProperty() connected!: boolean;
}

export class MatchResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() gameId!: string;
  @ApiProperty() gameVersion!: number;
  @ApiProperty({ enum: MatchStatus }) status!: MatchStatus;
  @ApiProperty() stateVersion!: number;
  @ApiProperty({ description: 'Game-module-defined, opaque to the platform.' })
  state!: unknown;
  @ApiProperty({ nullable: true, type: String }) winnerUserId!: string | null;
  @ApiProperty() resultIsDraw!: boolean;
  @ApiProperty({ enum: MatchTerminationReason, nullable: true })
  terminationReason!: MatchTerminationReason | null;
  @ApiProperty({ type: [MatchPlayerResponseDto] })
  players!: MatchPlayerResponseDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) startedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) completedAt!: Date | null;
}

export function toMatchResponse(
  match: Match & { players: MatchPlayer[] },
): MatchResponseDto {
  return {
    id: match.id,
    gameId: match.gameId,
    gameVersion: match.gameVersion,
    status: match.status,
    stateVersion: match.stateVersion,
    state: match.state,
    winnerUserId: match.winnerUserId,
    resultIsDraw: match.resultIsDraw,
    terminationReason: match.terminationReason,
    players: match.players.map((p) => ({
      userId: p.userId,
      seat: p.seat,
      connected: p.disconnectedAt === null,
    })),
    createdAt: match.createdAt,
    startedAt: match.startedAt,
    completedAt: match.completedAt,
  };
}
