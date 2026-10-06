import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsString, ValidateNested } from 'class-validator';
import { StakeRequestDto } from '../../match-stakes/dto/stake-request.dto.js';

export class CreateChallengeDto {
  @ApiProperty({ example: 'tic_tac_toe' })
  @IsString()
  gameId!: string;

  @ApiProperty({ description: "The challenged player's user id." })
  @IsString()
  opponentUserId!: string;

  @ApiProperty({
    required: false,
    type: StakeRequestDto,
    description:
      'Omit for ordinary free play. Immutable once the challenge is ' +
      'created — accepting commits to exactly this amount.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => StakeRequestDto)
  stake?: StakeRequestDto;
}
