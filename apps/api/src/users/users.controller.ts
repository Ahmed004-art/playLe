import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
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
import { UsersService } from './users.service.js';
import { ProfilesService } from './profiles.service.js';
import { UserLookupResponseDto } from './dto/user-lookup-response.dto.js';
import { PlayerProfileResponseDto } from './dto/player-profile-response.dto.js';
import { PlayerSummariesQueryDto } from './dto/player-summaries-query.dto.js';
import { PlayerSummariesResponseDto } from './dto/player-summary-response.dto.js';
import { BlocksService } from '../blocks/blocks.service.js';
import { isHiddenFromProfileAndLookup } from '../blocks/block-visibility.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';

@ApiTags('users')
@Controller({ path: 'users', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly profilesService: ProfilesService,
    private readonly blocksService: BlocksService,
  ) {}

  @Get('lookup')
  @ApiOperation({
    summary:
      'Resolve an exact username to a user id — used to start a direct challenge. ' +
      'Not a user directory/search feature. A player who has blocked you is ' +
      'indistinguishable from a username that does not exist.',
  })
  @ApiResponse({ status: 200, type: UserLookupResponseDto })
  @ApiResponse({ status: 404, description: 'No account with that username.' })
  async lookup(
    @CurrentUser() viewer: User,
    @Query('username') username: string,
  ): Promise<UserLookupResponseDto> {
    const user = username
      ? await this.usersService.findByUsername(username)
      : null;
    if (!user || user.status !== 'ACTIVE') {
      throw new NotFoundException('No account with that username');
    }
    if (user.id !== viewer.id) {
      const relation = await this.blocksService.relationBetween(
        viewer.id,
        user.id,
      );
      if (isHiddenFromProfileAndLookup(relation)) {
        throw new NotFoundException('No account with that username');
      }
    }
    return { id: user.id, username: user.username };
  }

  // Declared before any `:id` route so `summaries` is never read as an id.
  @Get('summaries')
  @ApiOperation({
    summary:
      'Labels (id, username, display name) for up to 50 players. Players who ' +
      'do not exist, or who have a block against you or you against them, are ' +
      'omitted without any marker.',
  })
  @ApiResponse({ status: 200, type: PlayerSummariesResponseDto })
  @ApiResponse({
    status: 400,
    description: 'A malformed id, or more than 50 unique ids.',
  })
  async summaries(
    @CurrentUser() viewer: User,
    @Query() query: PlayerSummariesQueryDto,
  ): Promise<PlayerSummariesResponseDto> {
    return {
      items: await this.profilesService.getSummaries(viewer.id, query.ids),
    };
  }

  @Get(':id/profile')
  @ApiOperation({
    summary:
      "A player's public profile: username, display name and win/loss/draw " +
      'statistics from completed matches. Nothing private.',
  })
  @ApiResponse({ status: 200, type: PlayerProfileResponseDto })
  @ApiResponse({ status: 400, description: 'Malformed id.' })
  @ApiResponse({
    status: 404,
    description: 'No such player (or one you may not see).',
  })
  profile(
    @CurrentUser() viewer: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PlayerProfileResponseDto> {
    return this.profilesService.getProfile(viewer.id, id);
  }
}
