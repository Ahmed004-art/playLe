import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class CreateDisputeDto {
  @ApiProperty({
    description: 'Why this match/settlement is being disputed.',
    minLength: 10,
  })
  @IsString()
  @MinLength(10)
  reason!: string;
}
