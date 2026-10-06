import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { IsAmountMinorString } from '../../common/validators/is-amount-minor.validator.js';

/**
 * A requested stake, embedded (optionally) into a matchmaking-join or
 * challenge-create request. Omitting `stake` entirely means ordinary
 * free play — see docs/decisions/ADR-016-match-financial-architecture.md.
 */
export class StakeRequestDto {
  @ApiProperty({
    description: 'Stake amount in minor units (1 SLE = 100 minor units).',
    example: '1000',
  })
  @IsString()
  @IsAmountMinorString()
  amountMinor!: string;

  @ApiProperty({ example: 'SLE' })
  @IsString()
  @IsIn(['SLE'])
  currency!: string;
}
