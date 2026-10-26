import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateBlockDto {
  @ApiProperty({ description: 'The id of the player to block.' })
  @IsUUID()
  userId!: string;
}
