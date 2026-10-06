import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { User } from '@prisma/client';
import { MatchmakingService } from './matchmaking.service.js';
import {
  MatchmakingGameDto,
  MatchmakingJoinResponseDto,
} from './dto/matchmaking.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';

const MATCHES_THROTTLE = { matches: {} };

@ApiTags('matchmaking')
@Controller({ path: 'matchmaking', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MatchmakingController {
  constructor(private readonly matchmakingService: MatchmakingService) {}

  @Post('join')
  @HttpCode(HttpStatus.OK)
  @Throttle(MATCHES_THROTTLE)
  @ApiOperation({
    summary:
      'Join the matchmaking queue for a game. "QUEUED" is only a provisional ' +
      'response — always listen for the match:found push, since a concurrent ' +
      'join may consume this user from the queue after this request returns.',
  })
  @ApiResponse({ status: 200, type: MatchmakingJoinResponseDto })
  @ApiResponse({
    status: 409,
    description: 'Already queued, or already in an active match.',
  })
  async join(
    @CurrentUser() user: User,
    @Body() dto: MatchmakingGameDto,
  ): Promise<MatchmakingJoinResponseDto> {
    return this.matchmakingService.join(dto.gameId, user, dto.stake);
  }

  @Post('leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Leave the matchmaking queue (idempotent).' })
  @ApiResponse({ status: 204 })
  async leave(@CurrentUser() user: User): Promise<void> {
    await this.matchmakingService.leave(user.id);
  }
}
