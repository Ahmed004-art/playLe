import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';
import { MATCH_COMMAND_TYPES } from '../matches.service.js';

export class SubmitCommandDto {
  @ApiProperty({
    description:
      'Client-generated id for this command attempt. Retrying the same ' +
      'submission with the same id returns the original result instead ' +
      'of reapplying the move.',
  })
  @IsString()
  @IsUUID()
  commandId!: string;

  @ApiPropertyOptional({
    description:
      'Defaults to "MOVE" for backward compatibility. "RESIGN" and ' +
      '"DRAW_OFFER"/"DRAW_ACCEPT"/"DRAW_REJECT" (Phase 9) go through the ' +
      'same server-authoritative pipeline as a move — see ADR-024.',
    enum: MATCH_COMMAND_TYPES,
    default: 'MOVE',
  })
  @IsOptional()
  @IsIn(MATCH_COMMAND_TYPES)
  type?: (typeof MATCH_COMMAND_TYPES)[number];

  @ApiProperty({
    description:
      'Game-specific move payload (e.g. `{ "cell": 4 }` for Tic-Tac-Toe). ' +
      'An empty object for RESIGN/DRAW_* commands, which need no payload.',
    example: { cell: 4 },
  })
  @IsObject()
  payload!: Record<string, unknown>;
}
