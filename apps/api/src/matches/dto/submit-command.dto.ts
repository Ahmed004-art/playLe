import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsString, IsUUID } from 'class-validator';

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

  @ApiProperty({
    description:
      'Game-specific move payload (e.g. `{ "cell": 4 }` for Tic-Tac-Toe).',
    example: { cell: 4 },
  })
  @IsObject()
  payload!: Record<string, unknown>;
}
