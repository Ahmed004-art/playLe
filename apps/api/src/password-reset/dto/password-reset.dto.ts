import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).+$/;

export class RequestPasswordResetDto {
  @ApiProperty({
    example: 'player@example.com',
    description: 'Email or phone number.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  identifier!: string;
}

export class ConfirmPasswordResetDto {
  @ApiProperty({ description: 'The code delivered to the account.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  token!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(PASSWORD_PATTERN, {
    message: 'newPassword must contain at least one letter and one number',
  })
  newPassword!: string;
}
