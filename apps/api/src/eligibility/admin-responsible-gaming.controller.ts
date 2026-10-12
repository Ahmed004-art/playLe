import { Controller, Get, Query, UseGuards } from '@nestjs/common';
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
import { ResponsibleGamingService } from './responsible-gaming.service.js';

class AdminResponsibleGamingQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;
}

/**
 * Read-only admin visibility into responsible-gaming restriction
 * history — no endpoint anywhere lifts or edits a restriction (see
 * `ResponsibleGamingService`'s class doc and ADR-021).
 */
@ApiTags('admin-responsible-gaming')
@Controller({ path: 'admin/responsible-gaming', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@ApiBearerAuth()
export class AdminResponsibleGamingController {
  constructor(private readonly service: ResponsibleGamingService) {}

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
}
