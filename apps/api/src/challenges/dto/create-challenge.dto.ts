import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CreateChallengeDto {
  @ApiProperty({ example: 'tic_tac_toe' })
  @IsString()
  gameId!: string;

  @ApiProperty({ description: "The challenged player's user id." })
  @IsString()
  opponentUserId!: string;
}
