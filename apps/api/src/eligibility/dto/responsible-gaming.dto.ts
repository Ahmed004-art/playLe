import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Max, Min } from 'class-validator';
import { IsAmountMinorString } from '../../common/validators/is-amount-minor.validator.js';

export class SetAmountLimitDto {
  @ApiProperty({ description: 'Minor units (1 SLE = 100 minor units).' })
  @IsString()
  @IsAmountMinorString()
  limitMinor!: string;
}

export class StartCoolingOffDto {
  @ApiProperty({
    description: 'Minutes from now until the cooling-off period ends.',
  })
  @IsInt()
  @Min(1)
  @Max(60 * 24 * 365)
  durationMinutes!: number;
}

/**
 * The authenticated user's current rolling-window usage — what's
 * actually being compared against their configured STAKE_LIMIT/
 * LOSS_LIMIT/DEPOSIT_LIMIT (see ADR-023). Amounts are decimal minor-unit
 * strings, the same wire convention as every other amount in this API
 * (see `apps/api/src/common/money.ts`) — never a float.
 */
export class ResponsibleGamingUsageDto {
  @ApiProperty({
    description: 'The fixed, non-user-configurable rolling-window length.',
  })
  windowHours!: number;

  @ApiProperty({ description: 'Sum of STAKE_HOLD amounts in the window.' })
  stakeHeldMinor!: string;

  @ApiProperty({
    description:
      'Sum of realized losses (LOSER settlement entries) in the window.',
  })
  lossMinor!: string;

  @ApiProperty({
    description: 'Sum of completed DEPOSIT amounts in the window.',
  })
  depositedMinor!: string;
}
