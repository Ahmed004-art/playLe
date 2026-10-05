import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { IsAmountMinorString } from '../../common/validators/is-amount-minor.validator.js';

export class CreateDepositDto {
  @ApiProperty({
    description: 'Deposit amount in minor units (1 SLE = 100 minor units).',
    example: '50000',
  })
  @IsString()
  @IsAmountMinorString()
  amountMinor!: string;
}
