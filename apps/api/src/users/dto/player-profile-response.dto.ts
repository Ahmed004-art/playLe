import { ApiProperty } from '@nestjs/swagger';

/**
 * Everything a player's public profile may contain. Deliberately an explicit
 * allow-list: nothing is copied from the `User` row wholesale, so a column
 * added to `User` later can never leak through here.
 */
export class PlayerProfileResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() username!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'As stored; clients fall back to the username when null.',
  })
  displayName!: string | null;
  @ApiProperty({
    description:
      'COMPLETED matches with a confirmed outcome (wins + losses + draws).',
  })
  gamesPlayed!: number;
  @ApiProperty() wins!: number;
  @ApiProperty() losses!: number;
  @ApiProperty() draws!: number;
}
