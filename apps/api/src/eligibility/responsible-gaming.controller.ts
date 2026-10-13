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
import { parseAmountMinor, toAmountString } from '../common/money.js';
import { EligibilityService } from './eligibility.service.js';
import { ResponsibleGamingService } from './responsible-gaming.service.js';
import {
  ResponsibleGamingUsageDto,
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
  constructor(
    private readonly service: ResponsibleGamingService,
    private readonly eligibilityService: EligibilityService,
  ) {}

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

  @Get('usage')
  @ApiOperation({
    summary:
      "The authenticated user's current rolling-window usage (Phase 8) — " +
      'what is actually compared against any configured STAKE_LIMIT/' +
      'LOSS_LIMIT/DEPOSIT_LIMIT. See ADR-023.',
  })
  @ApiResponse({ status: 200, type: ResponsibleGamingUsageDto })
  async usage(@CurrentUser() user: User): Promise<ResponsibleGamingUsageDto> {
    const usage = await this.eligibilityService.getRollingUsage(user.id);
    return {
      windowHours: usage.windowHours,
      stakeHeldMinor: toAmountString(usage.stakeHeldMinor),
      lossMinor: toAmountString(usage.lossMinor),
      depositedMinor: toAmountString(usage.depositedMinor),
    };
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
  @ApiOperation({
    summary:
      'Sets both a per-deposit ceiling and a rolling-window deposit ' +
      'total ceiling (see ADR-023).',
  })
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
  @ApiOperation({
    summary:
      'Sets both a per-stake ceiling and a rolling-window staked-total ' +
      'ceiling (see ADR-023).',
  })
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
      'Sets a rolling-window loss ceiling — enforced before any new ' +
      'stake is confirmed once reached (see ADR-023); not retroactive ' +
      "to a stake already in progress, since that stake's outcome is " +
      'not yet known.',
  })
  @ApiResponse({ status: 200 })
  async lossLimit(
    @CurrentUser() user: User,
    @Body() dto: SetAmountLimitDto,
  ): Promise<ResponsibleGamingRestriction> {
    return this.service.setLossLimit(user.id, parseAmountMinor(dto.limitMinor));
  }
}
