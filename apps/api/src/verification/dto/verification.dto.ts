import { ApiProperty } from '@nestjs/swagger';
import { VerificationChannel } from '@prisma/client';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RequestVerificationDto {
  @ApiProperty({ enum: VerificationChannel })
  @IsIn(['EMAIL', 'SMS'])
  channel!: VerificationChannel;
}

export class ConfirmVerificationDto {
  @ApiProperty({ enum: VerificationChannel })
  @IsIn(['EMAIL', 'SMS'])
  channel!: VerificationChannel;

  @ApiProperty({ example: '123456' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  code!: string;
}
