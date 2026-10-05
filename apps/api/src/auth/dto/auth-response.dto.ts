import { ApiProperty } from '@nestjs/swagger';
import { UserRole, UserStatus } from '@prisma/client';

/** The safe, public-facing shape of a user — never includes `passwordHash`. */
export class UserResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ nullable: true, type: String }) phoneNumber!: string | null;
  @ApiProperty() username!: string;
  @ApiProperty({ nullable: true, type: String }) displayName!: string | null;
  @ApiProperty({ nullable: true, type: String }) avatarUrl!: string | null;
  @ApiProperty({ enum: UserRole }) role!: UserRole;
  @ApiProperty({ enum: UserStatus }) status!: UserStatus;
  @ApiProperty() dateOfBirth!: Date;
  @ApiProperty({ nullable: true, type: Date }) emailVerifiedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) phoneVerifiedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) lastLoginAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class AuthResponseDto {
  @ApiProperty({ type: UserResponseDto })
  user!: UserResponseDto;

  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({
    description: 'ISO 8601 expiry timestamp of the refresh token.',
  })
  refreshTokenExpiresAt!: string;
}
