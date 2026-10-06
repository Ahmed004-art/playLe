import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MinLength } from 'class-validator';

export class ResolveDisputeDto {
  @ApiProperty({ enum: ['UNDER_REVIEW', 'UPHELD', 'REFUNDED', 'RESOLVED'] })
  @IsIn(['UNDER_REVIEW', 'UPHELD', 'REFUNDED', 'RESOLVED'])
  status!: 'UNDER_REVIEW' | 'UPHELD' | 'REFUNDED' | 'RESOLVED';

  @ApiProperty({
    description:
      'Required, audited explanation. Any actual monetary correction ' +
      '(if the dispute is upheld) is a separate, already-audited admin ' +
      'adjustment (POST /admin/wallets/:userId/adjustments) — resolving ' +
      'a dispute never itself moves money.',
    minLength: 10,
  })
  @IsString()
  @MinLength(10)
  resolution!: string;
}
