import {
  Body,
  Controller,
  Get,
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
import { DisputesService } from './disputes.service.js';
import { CreateDisputeDto } from './dto/create-dispute.dto.js';
import {
  DisputeResponseDto,
  toDisputeResponse,
} from './dto/dispute-response.dto.js';
import { PaginationQueryDto } from '../common/dto/pagination.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';

const STAKES_THROTTLE = { stakes: {} };

@ApiTags('disputes')
@Controller({ version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  @Post('matches/:id/dispute')
  @Throttle(STAKES_THROTTLE)
  @ApiOperation({
    summary:
      'Dispute a completed/abandoned match you played in. Never itself ' +
      'changes any balance — see docs/architecture/SECURITY.md.',
  })
  @ApiResponse({ status: 201, type: DisputeResponseDto })
  async create(
    @CurrentUser() user: User,
    @Param('id') matchId: string,
    @Body() dto: CreateDisputeDto,
  ): Promise<DisputeResponseDto> {
    const dispute = await this.disputesService.create(
      user.id,
      matchId,
      dto.reason,
    );
    return toDisputeResponse(dispute);
  }

  @Get('disputes')
  @ApiOperation({ summary: "The authenticated user's own disputes." })
  @ApiResponse({ status: 200, type: [DisputeResponseDto] })
  async list(
    @CurrentUser() user: User,
    @Query() query: PaginationQueryDto,
  ): Promise<{ items: DisputeResponseDto[]; nextCursor: string | null }> {
    const page = await this.disputesService.list(user.id, query);
    return {
      items: page.items.map(toDisputeResponse),
      nextCursor: page.nextCursor,
    };
  }
}
