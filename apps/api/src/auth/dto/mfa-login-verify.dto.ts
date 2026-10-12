import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class MfaLoginVerifyDto {
  @ApiProperty({ description: 'From the mfaRequired login response.' })
  @IsString()
  @IsNotEmpty()
  mfaChallengeToken!: string;

  @ApiProperty({
    description:
      'A current 6-digit TOTP code, or an 8-character recovery code.',
    example: '123456',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  code!: string;
}
