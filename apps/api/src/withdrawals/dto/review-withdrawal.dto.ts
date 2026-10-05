import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** Every admin withdrawal action requires a recorded reason — see spec. */
export class ReviewWithdrawalDto {
  @ApiProperty({
    example: 'Verified mobile money account ownership via support ticket #482',
  })
  @IsString()
  @MinLength(10, { message: 'reason must be at least 10 characters' })
  reason!: string;
}
