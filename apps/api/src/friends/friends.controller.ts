import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { FriendsService } from './friends.service.js';
import {
  CreateFriendRequestDto,
  FriendRequestResponseDto,
  FriendRequestsQueryDto,
  FriendResponseDto,
  toFriendRequestResponse,
  toFriendResponse,
} from './dto/friends.dto.js';
import { PaginationQueryDto } from '../common/dto/pagination.dto.js';
import { SocialThrottle } from '../common/social-throttle.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';

@ApiTags('friends')
@Controller({ path: 'friends', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FriendsController {
  constructor(private readonly friendsService: FriendsService) {}

  @Post('requests')
  @SocialThrottle()
  @ApiOperation({
    summary:
      'Send a friend request. If that player already asked you, their ' +
      'request is accepted instead (status ACCEPTED). A player who has ' +
      'blocked you looks exactly like one that does not exist.',
  })
  @ApiResponse({ status: 201, type: FriendRequestResponseDto })
  @ApiResponse({
    status: 409,
    description:
      'Duplicate request, already friends, you blocked them, or a limit (200 friends, 50 pending requests).',
  })
  async send(
    @CurrentUser() user: User,
    @Body() dto: CreateFriendRequestDto,
  ): Promise<FriendRequestResponseDto> {
    return toFriendRequestResponse(
      await this.friendsService.sendRequest(user.id, dto.userId),
      user.id,
    );
  }

  @Get('requests')
  @ApiOperation({
    summary: 'Your pending friend requests, incoming (default) or outgoing.',
  })
  @ApiResponse({ status: 200, type: [FriendRequestResponseDto] })
  async listRequests(
    @CurrentUser() user: User,
    @Query() query: FriendRequestsQueryDto,
  ): Promise<{ items: FriendRequestResponseDto[]; nextCursor: string | null }> {
    const page = await this.friendsService.listRequests(
      user.id,
      query.direction,
      query,
    );
    return {
      items: page.items.map((r) => toFriendRequestResponse(r, user.id)),
      nextCursor: page.nextCursor,
    };
  }

  @Post('requests/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a request sent to you.' })
  @ApiResponse({ status: 200, type: FriendRequestResponseDto })
  async accept(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FriendRequestResponseDto> {
    return toFriendRequestResponse(
      await this.friendsService.acceptRequest(user.id, id),
      user.id,
    );
  }

  @Post('requests/:id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a request sent to you.' })
  @ApiResponse({ status: 200, type: FriendRequestResponseDto })
  async decline(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FriendRequestResponseDto> {
    return toFriendRequestResponse(
      await this.friendsService.declineRequest(user.id, id),
      user.id,
    );
  }

  @Post('requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a request you sent, while still pending.' })
  @ApiResponse({ status: 200, type: FriendRequestResponseDto })
  async cancel(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FriendRequestResponseDto> {
    return toFriendRequestResponse(
      await this.friendsService.cancelRequest(user.id, id),
      user.id,
    );
  }

  @Get()
  @ApiOperation({
    summary:
      'Your friends, with best-effort presence (shown only for your own ' +
      'friends; OFFLINE when unknown or if the presence store is down).',
  })
  @ApiResponse({ status: 200, type: [FriendResponseDto] })
  async list(
    @CurrentUser() user: User,
    @Query() query: PaginationQueryDto,
  ): Promise<{ items: FriendResponseDto[]; nextCursor: string | null }> {
    const page = await this.friendsService.listFriends(user.id, query);
    return {
      items: page.items.map(toFriendResponse),
      nextCursor: page.nextCursor,
    };
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Remove a friend. Does not block them, and nothing recreates the friendship.',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'Not one of your friends.' })
  async remove(
    @CurrentUser() user: User,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.friendsService.removeFriend(user.id, userId);
  }
}
