import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { GamesService } from './games.service.js';
import { toGameResponse, GameResponseDto } from './dto/game-response.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';

@ApiTags('games')
@Controller({ path: 'games', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class GamesController {
  constructor(private readonly gamesService: GamesService) {}

  @Get()
  @ApiOperation({ summary: 'List enabled games in the catalog.' })
  @ApiResponse({ status: 200, type: [GameResponseDto] })
  async list(): Promise<GameResponseDto[]> {
    const games = await this.gamesService.listEnabled();
    return games.map(toGameResponse);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A single game from the catalog.' })
  @ApiResponse({ status: 200, type: GameResponseDto })
  @ApiResponse({ status: 404, description: 'Not found, or disabled.' })
  async findOne(@Param('id') id: string): Promise<GameResponseDto> {
    const game = await this.gamesService.findEnabledById(id);
    return toGameResponse(game);
  }
}
