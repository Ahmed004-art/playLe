import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmptyObject, IsString } from 'class-validator';
import { IsAmountMinorString } from '../../common/validators/is-amount-minor.validator.js';

export class CreateWithdrawalDto {
  @ApiProperty({
    description: 'Withdrawal amount in minor units (1 SLE = 100 minor units).',
    example: '50000',
  })
  @IsString()
  @IsAmountMinorString()
  amountMinor!: string;

  @ApiProperty({
    description:
      'Abstracted payout destination (e.g. mobile money provider + number). ' +
      'Not identity-verified in Phase 3 — see CLAUDE.md KYC exclusion.',
    example: { method: 'ORANGE_MONEY', phoneNumber: '+23276000000' },
  })
  @IsNotEmptyObject()
  destinationDetails!: Record<string, unknown>;
}
