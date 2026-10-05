import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class MatchmakingGameDto {
  @ApiProperty({ example: 'tic_tac_toe' })
  @IsString()
  gameId!: string;
}

export class MatchmakingJoinResponseDto {
  @ApiProperty({ enum: ['QUEUED', 'MATCHED'] })
  status!: 'QUEUED' | 'MATCHED';

  @ApiProperty({ required: false, nullable: true, type: String })
  matchId?: string;
}
