import { ApiProperty } from '@nestjs/swagger';

/** Just enough to label a player in a list. Nothing else, ever. */
export class PlayerSummaryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() username!: string;
  @ApiProperty({ nullable: true, type: String }) displayName!: string | null;
}

export class PlayerSummariesResponseDto {
  @ApiProperty({ type: [PlayerSummaryResponseDto] })
  items!: PlayerSummaryResponseDto[];
}
