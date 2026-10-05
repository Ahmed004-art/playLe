import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Password policy: at least 8 characters, at least one letter and one
 * number. Deliberately not more aggressive than this for Phase 2 — see
 * ADR-011.
 */
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).+$/;
const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{2,19}$/;

export class RegisterDto {
  @ApiProperty({ example: 'player@example.com' })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiPropertyOptional({
    example: '+23276000000',
    description: 'Sierra Leone numbers may be given without a country code.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phoneNumber?: string;

  @ApiProperty({
    example: 'playerone',
    description:
      'Letters, numbers, and underscores only; must start with a letter; 3-20 characters.',
  })
  @IsString()
  @Matches(USERNAME_PATTERN, {
    message:
      'username must start with a letter and contain only letters, numbers, and underscores (3-20 characters)',
  })
  username!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(PASSWORD_PATTERN, {
    message: 'password must contain at least one letter and one number',
  })
  password!: string;

  @ApiProperty({
    example: '2000-01-01',
    description:
      'ISO 8601 date. Used for the server-side minimum-age check — never trust a client-supplied age.',
  })
  @IsDateString()
  dateOfBirth!: string;
}
