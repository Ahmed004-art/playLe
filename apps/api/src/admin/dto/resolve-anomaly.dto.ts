import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** Mirrors `ReviewWithdrawalDto` — every admin action here requires a recorded reason. */
export class ResolveAnomalyDto {
  @ApiProperty({
    example:
      'Confirmed with Monime support that payout pyt-123 completed; ledger matches.',
  })
  @IsString()
  @MinLength(10, { message: 'resolutionNote must be at least 10 characters' })
  resolutionNote!: string;
}
