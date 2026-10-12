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
