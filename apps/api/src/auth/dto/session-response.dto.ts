import { ApiProperty } from '@nestjs/swagger';

export class SessionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() familyId!: string;
  @ApiProperty({ nullable: true, type: String }) userAgent!: string | null;
  @ApiProperty({ nullable: true, type: String }) ipAddress!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() expiresAt!: Date;
}
