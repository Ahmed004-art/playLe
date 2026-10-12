import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class MfaCodeDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  code!: string;
}

export class MfaEnrollResponseDto {
  @ApiProperty({ description: 'Base32 TOTP secret — for manual entry.' })
  secret!: string;

  @ApiProperty({ description: 'otpauth:// URI — render as a QR code.' })
  otpauthUri!: string;
}

export class MfaConfirmResponseDto {
  @ApiProperty({
    type: [String],
    description:
      'Single-use recovery codes, shown exactly once — store them safely.',
  })
  recoveryCodes!: string[];
}

export class MfaStatusResponseDto {
  @ApiProperty() enabled!: boolean;
}
