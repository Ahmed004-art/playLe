import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsString, ValidateNested } from 'class-validator';
import { StakeRequestDto } from '../../match-stakes/dto/stake-request.dto.js';

export class MatchmakingGameDto {
  @ApiProperty({ example: 'tic_tac_toe' })
  @IsString()
  gameId!: string;

  @ApiProperty({
    required: false,
    type: StakeRequestDto,
    description:
      'Omit for ordinary free play. When given, only matches with a ' +
      'player queued for the identical stake amount/currency.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => StakeRequestDto)
  stake?: StakeRequestDto;
}

export class MatchmakingJoinResponseDto {
  @ApiProperty({ enum: ['QUEUED', 'MATCHED'] })
  status!: 'QUEUED' | 'MATCHED';

  @ApiProperty({ required: false, nullable: true, type: String })
  matchId?: string;
}
