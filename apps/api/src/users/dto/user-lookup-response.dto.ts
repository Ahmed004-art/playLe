import { ApiProperty } from '@nestjs/swagger';

/**
 * Deliberately minimal — just enough to resolve a known username to a
 * user id for the direct-challenge flow (there is no social/friends
 * directory feature; see CLAUDE.md "what not to build yet"). Never
 * returns anything beyond id/username.
 */
export class UserLookupResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() username!: string;
}
