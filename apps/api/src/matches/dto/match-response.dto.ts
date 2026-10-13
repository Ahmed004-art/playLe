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
  @ApiProperty({
    nullable: true,
    type: Date,
    description:
      'The deadline for whoever currently holds the turn to move (Phase ' +
      '9). Display-only for the client — the server is the sole arbiter ' +
      'of expiry (see ADR-024).',
  })
  turnDeadlineAt!: Date | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'The userId of whoever currently has a pending draw offer open, if any.',
  })
  pendingDrawOfferByUserId!: string | null;
  @ApiProperty({
    description: 'Whether this game accepts a RESIGN command (Phase 9).',
  })
  supportsResignation!: boolean;
  @ApiProperty({
    description:
      'Whether this game accepts DRAW_OFFER/DRAW_ACCEPT/DRAW_REJECT (Phase 9).',
  })
  supportsDraws!: boolean;
  @ApiProperty({ type: [MatchPlayerResponseDto] })
  players!: MatchPlayerResponseDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) startedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) completedAt!: Date | null;
}

export function toMatchResponse(
  match: Match & { players: MatchPlayer[] },
  capabilities: { supportsResignation: boolean; supportsDraws: boolean },
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
    turnDeadlineAt: match.turnDeadlineAt,
    pendingDrawOfferByUserId: match.pendingDrawOfferByUserId,
    supportsResignation: capabilities.supportsResignation,
    supportsDraws: capabilities.supportsDraws,
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
