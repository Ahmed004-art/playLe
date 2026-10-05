import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MinLength } from 'class-validator';
import { IsAmountMinorString } from '../../common/validators/is-amount-minor.validator.js';

/**
 * The only balance-editing mechanism in the system besides deposits/
 * withdrawals themselves. There is deliberately no "set balance to X"
 * endpoint — only a relative credit/debit, always reason-required and
 * always going through the same invariant checks as every other mutation.
 */
export class AdjustWalletDto {
  @ApiProperty({ enum: ['CREDIT', 'DEBIT'] })
  @IsIn(['CREDIT', 'DEBIT'])
  direction!: 'CREDIT' | 'DEBIT';

  @ApiProperty({ example: '1000' })
  @IsString()
  @IsAmountMinorString()
  amountMinor!: string;

  @ApiProperty({
    example:
      'Reversing deposit #abc123 — provider confirmed a duplicate charge',
  })
  @IsString()
  @MinLength(10, { message: 'reason must be at least 10 characters' })
  reason!: string;
}
