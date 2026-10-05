import {
  Body,
  Controller,
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
import { Throttle } from '@nestjs/throttler';
import type { User } from '@prisma/client';
import { ChallengesService } from './challenges.service.js';
import { CreateChallengeDto } from './dto/create-challenge.dto.js';
import {
  toChallengeResponse,
  ChallengeResponseDto,
} from './dto/challenge-response.dto.js';
import { PaginationQueryDto } from '../common/dto/pagination.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';

const MATCHES_THROTTLE = { matches: {} };

@ApiTags('challenges')
@Controller({ path: 'challenges', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ChallengesController {
  constructor(private readonly challengesService: ChallengesService) {}

  @Post()
  @Throttle(MATCHES_THROTTLE)
  @ApiOperation({ summary: 'Challenge another player directly to a game.' })
  @ApiResponse({ status: 201, type: ChallengeResponseDto })
  async create(
    @CurrentUser() user: User,
    @Body() dto: CreateChallengeDto,
  ): Promise<ChallengeResponseDto> {
    const challenge = await this.challengesService.create(
      dto.gameId,
      user.id,
      dto.opponentUserId,
    );
    return toChallengeResponse(challenge);
  }

  @Get()
  @ApiOperation({
    summary: "The authenticated user's own sent/received challenges.",
  })
  @ApiResponse({ status: 200, type: [ChallengeResponseDto] })
  async list(
    @CurrentUser() user: User,
    @Query() query: PaginationQueryDto,
  ): Promise<{ items: ChallengeResponseDto[]; nextCursor: string | null }> {
    const page = await this.challengesService.list(user.id, query);
    return {
      items: page.items.map(toChallengeResponse),
      nextCursor: page.nextCursor,
    };
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @Throttle(MATCHES_THROTTLE)
  @ApiOperation({ summary: 'Accept a pending challenge — creates the match.' })
  @ApiResponse({ status: 200, type: ChallengeResponseDto })
  async accept(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<ChallengeResponseDto> {
    const challenge = await this.challengesService.accept(user.id, id);
    return toChallengeResponse(challenge);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a pending challenge.' })
  @ApiResponse({ status: 200, type: ChallengeResponseDto })
  async decline(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<ChallengeResponseDto> {
    const challenge = await this.challengesService.decline(user.id, id);
    return toChallengeResponse(challenge);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a challenge you sent, while still pending.',
  })
  @ApiResponse({ status: 200, type: ChallengeResponseDto })
  async cancel(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<ChallengeResponseDto> {
    const challenge = await this.challengesService.cancel(user.id, id);
    return toChallengeResponse(challenge);
  }
}
