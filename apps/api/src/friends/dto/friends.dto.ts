import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import type {
  FriendRequestView,
  FriendView,
  PlayerSummary,
} from '../friends.service.js';

export class CreateFriendRequestDto {
  @ApiProperty({ description: 'The id of the player to send a request to.' })
  @IsUUID()
  userId!: string;
}

export class FriendRequestsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['incoming', 'outgoing'], default: 'incoming' })
  @IsOptional()
  @IsIn(['incoming', 'outgoing'])
  direction: 'incoming' | 'outgoing' = 'incoming';
}

/** A player as shown to a friend or in a request: id, username, display name. */
export class FriendPlayerDto {
  @ApiProperty() id!: string;
  @ApiProperty() username!: string;
  @ApiProperty({ nullable: true, type: String }) displayName!: string | null;
}

export class FriendRequestResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED'] })
  status!: string;
  @ApiProperty({
    enum: ['INCOMING', 'OUTGOING'],
    description: 'Relative to the authenticated player.',
  })
  direction!: 'INCOMING' | 'OUTGOING';
  @ApiProperty({
    type: FriendPlayerDto,
    description: 'The other player in the request.',
  })
  player!: FriendPlayerDto;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) respondedAt!: Date | null;
}

export class FriendResponseDto {
  @ApiProperty() userId!: string;
  @ApiProperty() username!: string;
  @ApiProperty({ nullable: true, type: String }) displayName!: string | null;
  @ApiProperty({
    enum: ['ONLINE', 'IN_MATCH', 'SEARCHING', 'OFFLINE'],
    description:
      'Best-effort and only ever shown for your own friends; OFFLINE when unknown.',
  })
  presence!: 'ONLINE' | 'IN_MATCH' | 'SEARCHING' | 'OFFLINE';
  @ApiProperty() friendsSince!: Date;
}

const pick = (p: PlayerSummary): FriendPlayerDto => ({
  id: p.id,
  username: p.username,
  displayName: p.displayName,
});

/** An explicit allow-list: nothing is copied from the row wholesale. */
export function toFriendRequestResponse(
  request: FriendRequestView,
  viewerId: string,
): FriendRequestResponseDto {
  const incoming = request.addresseeId === viewerId;
  return {
    id: request.id,
    status: request.status,
    direction: incoming ? 'INCOMING' : 'OUTGOING',
    player: pick(incoming ? request.requester : request.addressee),
    createdAt: request.createdAt,
    respondedAt: request.respondedAt,
  };
}

export function toFriendResponse(view: FriendView): FriendResponseDto {
  return {
    userId: view.friend.id,
    username: view.friend.username,
    displayName: view.friend.displayName,
    presence: view.presence,
    friendsSince: view.friendsSince,
  };
}
