import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { BlocksService } from './blocks.service.js';
import { CreateBlockDto } from './dto/create-block.dto.js';
import { BlockResponseDto, toBlockResponse } from './dto/block-response.dto.js';
import { PaginationQueryDto } from '../common/dto/pagination.dto.js';
import { SocialThrottle } from '../common/social-throttle.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';

@ApiTags('blocks')
@Controller({ path: 'blocks', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@SocialThrottle()
export class BlocksController {
  constructor(private readonly blocksService: BlocksService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Block a player. Idempotent. Cancels pending challenges between you ' +
      'and them; neither of you can challenge the other until you unblock.',
  })
  @ApiResponse({ status: 200, type: BlockResponseDto })
  @ApiResponse({ status: 400, description: 'You cannot block yourself.' })
  @ApiResponse({ status: 404, description: 'No such player.' })
  async block(
    @CurrentUser() user: User,
    @Body() dto: CreateBlockDto,
  ): Promise<BlockResponseDto> {
    return toBlockResponse(await this.blocksService.block(user.id, dto.userId));
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Remove your block on a player. Idempotent. Does not restore anything ' +
      'the block cancelled.',
  })
  @ApiResponse({ status: 204 })
  async unblock(
    @CurrentUser() user: User,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.blocksService.unblock(user.id, userId);
  }

  @Get()
  @ApiOperation({
    summary: 'Players you have blocked. Never reveals who has blocked you.',
  })
  @ApiResponse({ status: 200, type: [BlockResponseDto] })
  async list(
    @CurrentUser() user: User,
    @Query() query: PaginationQueryDto,
  ): Promise<{ items: BlockResponseDto[]; nextCursor: string | null }> {
    const page = await this.blocksService.list(user.id, query);
    return {
      items: page.items.map(toBlockResponse),
      nextCursor: page.nextCursor,
    };
  }
}
