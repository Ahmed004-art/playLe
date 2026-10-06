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
import { MatchesService } from './matches.service.js';
import { SubmitCommandDto } from './dto/submit-command.dto.js';
import { toMatchResponse, MatchResponseDto } from './dto/match-response.dto.js';
import {
  toCommandResponse,
  CommandResponseDto,
} from './dto/command-response.dto.js';
import { PaginationQueryDto } from '../common/dto/pagination.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { MatchStakesService } from '../match-stakes/match-stakes.service.js';
import {
  MatchFinancialResponseDto,
  toMatchStakeResponse,
  toSettlementResponse,
} from '../match-stakes/dto/match-financial-response.dto.js';

const MATCHES_THROTTLE = { matches: {} };

@ApiTags('matches')
@Controller({ path: 'matches', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MatchesController {
  constructor(
    private readonly matchesService: MatchesService,
    private readonly matchStakesService: MatchStakesService,
  ) {}

  @Get()
  @ApiOperation({ summary: "The authenticated user's own match history." })
  @ApiResponse({ status: 200, type: [MatchResponseDto] })
  async list(
    @CurrentUser() user: User,
    @Query() query: PaginationQueryDto,
  ): Promise<{ items: MatchResponseDto[]; nextCursor: string | null }> {
    const page = await this.matchesService.list(user.id, query);
    return {
      items: page.items.map(toMatchResponse),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Authoritative match state — the reconnect-safe source of truth for status/state/stateVersion.',
  })
  @ApiResponse({ status: 200, type: MatchResponseDto })
  @ApiResponse({ status: 404, description: 'Not found, or not a participant.' })
  async findOne(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<MatchResponseDto> {
    const match = await this.matchesService.findByIdForUser(user.id, id);
    return toMatchResponse(match);
  }

  @Post(':id/commands')
  @HttpCode(HttpStatus.OK)
  @Throttle(MATCHES_THROTTLE)
  @ApiOperation({
    summary:
      'Submit a game command (e.g. a move). Server-validated and server-authoritative — never trust a client-claimed outcome.',
  })
  @ApiResponse({ status: 200, type: CommandResponseDto })
  async submitCommand(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: SubmitCommandDto,
  ): Promise<CommandResponseDto> {
    const command = await this.matchesService.submitCommand(
      user.id,
      id,
      dto.commandId,
      dto.payload,
    );
    return toCommandResponse(command);
  }

  @Post(':id/stake/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle(MATCHES_THROTTLE)
  @ApiOperation({
    summary:
      'Confirm (hold) your stake for a financially-backed match. The match ' +
      'becomes ACTIVE once every player has confirmed.',
  })
  @ApiResponse({ status: 200, type: MatchFinancialResponseDto })
  async confirmStake(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<MatchFinancialResponseDto> {
    const stake = await this.matchStakesService.confirmStake(user, id);
    return { stake: toMatchStakeResponse(stake), settlement: null };
  }

  @Get(':id/financial')
  @ApiOperation({
    summary:
      "A match's stake and settlement, if any. Both null for ordinary free play.",
  })
  @ApiResponse({ status: 200, type: MatchFinancialResponseDto })
  async financial(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<MatchFinancialResponseDto> {
    const { stake, settlement } =
      await this.matchStakesService.getFinancialView(user.id, id);
    return {
      stake: stake ? toMatchStakeResponse(stake) : null,
      settlement: settlement ? toSettlementResponse(settlement) : null,
    };
  }
}
