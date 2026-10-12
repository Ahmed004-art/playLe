import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { TokenService } from './token.service.js';
import { SessionResponseDto } from './dto/session-response.dto.js';

/**
 * Session management on top of the existing rotating-refresh-token
 * system (`RefreshToken`) — lets a user see and selectively end their
 * own active sessions ("manage your devices"), without adding any new
 * session-tracking primitive.
 */
@ApiTags('sessions')
@Controller({ path: 'auth/sessions', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SessionsController {
  constructor(private readonly tokenService: TokenService) {}

  @Get()
  @ApiOperation({ summary: "The authenticated user's active sessions." })
  @ApiResponse({ status: 200, type: [SessionResponseDto] })
  async list(@CurrentUser() user: User): Promise<SessionResponseDto[]> {
    return this.tokenService.listActiveSessions(user.id);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Ends one specific session (by its listed id).' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'Not found, or not owned by you.' })
  async revoke(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<void> {
    const revoked = await this.tokenService.revokeSessionById(user.id, id);
    if (!revoked) {
      throw new NotFoundException('Session not found');
    }
  }

  @Post('revoke-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Ends every active session for this account, including the one making this request.',
  })
  @ApiResponse({ status: 204 })
  async revokeAll(@CurrentUser() user: User): Promise<void> {
    await this.tokenService.revokeAllForUser(user.id);
  }
}
