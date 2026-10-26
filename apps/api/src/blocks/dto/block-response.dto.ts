import { ApiProperty } from '@nestjs/swagger';
import type { BlockWithUser } from '../blocks.service.js';

export class BlockResponseDto {
  @ApiProperty({ description: 'The blocked player.' }) userId!: string;
  @ApiProperty() username!: string;
  @ApiProperty({ nullable: true, type: String }) displayName!: string | null;
  @ApiProperty() blockedAt!: Date;
}

export function toBlockResponse(block: BlockWithUser): BlockResponseDto {
  return {
    userId: block.blocked.id,
    username: block.blocked.username,
    displayName: block.blocked.displayName,
    blockedAt: block.createdAt,
  };
}
