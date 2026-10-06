import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { MatchesService } from '../matches/matches.service.js';
import {
  toMatchResponse,
  MatchResponseDto,
} from '../matches/dto/match-response.dto.js';
import { AdminMatchesQueryDto } from './dto/admin-matches-query.dto.js';
import { MatchStakesService } from '../match-stakes/match-stakes.service.js';
import {
  MatchFinancialResponseDto,
  toMatchStakeResponse,
  toSettlementResponse,
} from '../match-stakes/dto/match-financial-response.dto.js';

/**
 * Read-only match visibility for admins — no result-override endpoint of
 * any kind exists or is planned for this phase (see CLAUDE.md, "no
 * generic Set winner button").
 */
@ApiTags('admin-matches')
@Controller({ path: 'admin/matches', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@ApiBearerAuth()
export class AdminMatchesController {
  constructor(
    private readonly matchesService: MatchesService,
    private readonly matchStakesService: MatchStakesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List matches, optionally filtered by gameId/status (admin).',
  })
  @ApiResponse({ status: 200, type: [MatchResponseDto] })
  async list(
    @Query() query: AdminMatchesQueryDto,
  ): Promise<{ items: MatchResponseDto[]; nextCursor: string | null }> {
    const page = await this.matchesService.listAdmin({
      gameId: query.gameId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.map(toMatchResponse),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'A single match, including players and termination reason (admin).',
  })
  @ApiResponse({ status: 200, type: MatchResponseDto })
  async findOne(@Param('id') id: string): Promise<MatchResponseDto> {
    const match = await this.matchesService.findByIdAdmin(id);
    return toMatchResponse(match);
  }

  @Get(':id/financial')
  @ApiOperation({
    summary:
      "A match's stake, pool, fee, and settlement — full financial " +
      'inspection, no participant restriction (admin). Read-only — there ' +
      'is no endpoint here to set or override a result (see CLAUDE.md).',
  })
  @ApiResponse({ status: 200, type: MatchFinancialResponseDto })
  async financial(@Param('id') id: string): Promise<MatchFinancialResponseDto> {
    const { stake, settlement } =
      await this.matchStakesService.getFinancialViewAdmin(id);
    return {
      stake: stake ? toMatchStakeResponse(stake) : null,
      settlement: settlement ? toSettlementResponse(settlement) : null,
    };
  }
}
