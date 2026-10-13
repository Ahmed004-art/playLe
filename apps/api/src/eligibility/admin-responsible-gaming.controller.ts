import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import type { ResponsibleGamingRestriction } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { toAmountString } from '../common/money.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EligibilityService } from './eligibility.service.js';
import { ResponsibleGamingUsageDto } from './dto/responsible-gaming.dto.js';
import { ResponsibleGamingService } from './responsible-gaming.service.js';

class AdminResponsibleGamingQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;
}

/**
 * Read-only admin visibility into responsible-gaming restriction
 * history and current rolling-window usage — no endpoint anywhere
 * lifts or edits a restriction, and nothing here mutates a balance or
 * ledger row (see `ResponsibleGamingService`'s class doc and ADR-021).
 */
@ApiTags('admin-responsible-gaming')
@Controller({ path: 'admin/responsible-gaming', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@ApiBearerAuth()
export class AdminResponsibleGamingController {
  constructor(
    private readonly service: ResponsibleGamingService,
    private readonly eligibilityService: EligibilityService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List responsible-gaming restriction history, optionally filtered ' +
      'by userId. Read-only — no action here ever lifts or edits one.',
  })
  async list(
    @Query() query: AdminResponsibleGamingQueryDto,
  ): Promise<ResponsibleGamingRestriction[]> {
    return this.service.listHistoryAdmin({ userId: query.userId });
  }

  @Get(':userId/usage')
  @ApiOperation({
    summary:
      "A specific user's current rolling-window usage (Phase 8) — the " +
      'same figures `EligibilityService` actually enforces against. ' +
      'Read-only.',
  })
  async usage(
    @Param('userId') userId: string,
  ): Promise<ResponsibleGamingUsageDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const usage = await this.eligibilityService.getRollingUsage(userId);
    return {
      windowHours: usage.windowHours,
      stakeHeldMinor: toAmountString(usage.stakeHeldMinor),
      lossMinor: toAmountString(usage.lossMinor),
      depositedMinor: toAmountString(usage.depositedMinor),
    };
  }
}
