import { ApiProperty } from '@nestjs/swagger';
import type { MatchCommand } from '@prisma/client';

export class CommandResponseDto {
  @ApiProperty() commandId!: string;
  @ApiProperty() resultStatus!: string;
  @ApiProperty({ nullable: true, type: String }) rejectionReason!:
    string | null;
  @ApiProperty({ nullable: true, type: Number }) stateVersionAfter!:
    number | null;
}

export function toCommandResponse(command: MatchCommand): CommandResponseDto {
  return {
    commandId: command.id,
    resultStatus: command.resultStatus,
    rejectionReason: command.rejectionReason,
    stateVersionAfter: command.stateVersionAfter,
  };
}
