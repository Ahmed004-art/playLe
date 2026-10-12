import {
  Body,
  Controller,
  Get,
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
import type { ResponsibleGamingRestriction, User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { parseAmountMinor } from '../common/money.js';
import { ResponsibleGamingService } from './responsible-gaming.service.js';
import {
  SetAmountLimitDto,
  StartCoolingOffDto,
} from './dto/responsible-gaming.dto.js';

/**
 * Self-service responsible-gaming controls. There is deliberately no
 * endpoint anywhere in this codebase to lift a self-exclusion — see
 * `ResponsibleGamingService`'s class doc and ADR-021.
 */
@ApiTags('responsible-gaming')
@Controller({ path: 'auth/responsible-gaming', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ResponsibleGamingController {
  constructor(private readonly service: ResponsibleGamingService) {}

  @Get('status')
  @ApiOperation({
    summary: "The authenticated user's currently active restrictions.",
  })
  @ApiResponse({ status: 200, type: [Object] })
  async status(
    @CurrentUser() user: User,
  ): Promise<ResponsibleGamingRestriction[]> {
    return this.service.getActiveRestrictions(user.id);
  }

  @Post('self-exclude')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Permanently self-excludes from real-money play. Cannot be undone ' +
      'through this API — there is no lift endpoint.',
  })
  @ApiResponse({ status: 200 })
  async selfExclude(
    @CurrentUser() user: User,
  ): Promise<ResponsibleGamingRestriction> {
    return this.service.selfExclude(user.id);
  }

  @Post('cooling-off')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Starts a time-limited cooling-off period.' })
  @ApiResponse({ status: 200 })
  async coolingOff(
    @CurrentUser() user: User,
    @Body() dto: StartCoolingOffDto,
  ): Promise<ResponsibleGamingRestriction> {
    return this.service.startCoolingOff(user.id, dto.durationMinutes);
  }

  @Post('deposit-limit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sets a per-deposit amount ceiling.' })
  @ApiResponse({ status: 200 })
  async depositLimit(
    @CurrentUser() user: User,
    @Body() dto: SetAmountLimitDto,
  ): Promise<ResponsibleGamingRestriction> {
    return this.service.setDepositLimit(
      user.id,
      parseAmountMinor(dto.limitMinor),
    );
  }

  @Post('stake-limit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sets a per-stake amount ceiling.' })
  @ApiResponse({ status: 200 })
  async stakeLimit(
    @CurrentUser() user: User,
    @Body() dto: SetAmountLimitDto,
  ): Promise<ResponsibleGamingRestriction> {
    return this.service.setStakeLimit(
      user.id,
      parseAmountMinor(dto.limitMinor),
    );
  }

  @Post('loss-limit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sets a per-settlement loss ceiling (advisory; not yet enforced at settlement).',
  })
  @ApiResponse({ status: 200 })
  async lossLimit(
    @CurrentUser() user: User,
    @Body() dto: SetAmountLimitDto,
  ): Promise<ResponsibleGamingRestriction> {
    return this.service.setLossLimit(user.id, parseAmountMinor(dto.limitMinor));
  }
}
