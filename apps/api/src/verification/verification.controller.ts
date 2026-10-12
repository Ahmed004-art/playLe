import {
  Body,
  Controller,
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
import { Throttle } from '@nestjs/throttler';
import type { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { VerificationService } from './verification.service.js';
import {
  ConfirmVerificationDto,
  RequestVerificationDto,
} from './dto/verification.dto.js';

const AUTH_THROTTLE = { auth: {} };

@ApiTags('verification')
@Controller({ path: 'auth/verification', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  @Post('request')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Sends a one-time email or phone verification code.',
  })
  @ApiResponse({ status: 200 })
  async request(
    @CurrentUser() user: User,
    @Body() dto: RequestVerificationDto,
  ): Promise<{ message: string }> {
    await this.verificationService.requestChallenge(user, dto.channel);
    return { message: 'Verification code sent.' };
  }

  @Post('confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({ summary: 'Confirms a verification code.' })
  @ApiResponse({ status: 204 })
  @ApiResponse({
    status: 401,
    description: 'Invalid/expired code or too many attempts.',
  })
  async confirm(
    @CurrentUser() user: User,
    @Body() dto: ConfirmVerificationDto,
  ): Promise<void> {
    await this.verificationService.confirmChallenge(
      user,
      dto.channel,
      dto.code,
    );
  }
}
