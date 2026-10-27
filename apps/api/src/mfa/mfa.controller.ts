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
import { Throttle } from '@nestjs/throttler';
import type { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { MfaService } from './mfa.service.js';
import {
  MfaCodeDto,
  MfaConfirmResponseDto,
  MfaEnrollResponseDto,
  MfaStatusResponseDto,
} from './dto/mfa.dto.js';

const AUTH_THROTTLE = { auth: {} };

/**
 * Self-service TOTP MFA management for the authenticated account —
 * enrollment/confirmation/disablement/status. The login-time *challenge*
 * (`/auth/mfa/verify`) lives on `AuthController` instead, since it's
 * part of the login flow, not account management. `confirm`/`disable`
 * are throttled (same `auth` profile as login) — both check a guessable
 * 6-digit code and must not be brute-forceable just because the caller
 * already holds a valid access token.
 */
@ApiTags('mfa')
@Controller({ path: 'auth/mfa', version: '1' })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MfaController {
  constructor(private readonly mfaService: MfaService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Whether MFA is currently enabled for this account.',
  })
  @ApiResponse({ status: 200, type: MfaStatusResponseDto })
  async status(@CurrentUser() user: User): Promise<MfaStatusResponseDto> {
    return { enabled: await this.mfaService.isEnrolled(user.id) };
  }

  @Post('enroll')
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Starts (or resumes) TOTP enrollment. Enforces nothing until confirmed.',
  })
  @ApiResponse({ status: 200, type: MfaEnrollResponseDto })
  async enroll(@CurrentUser() user: User): Promise<MfaEnrollResponseDto> {
    return this.mfaService.enroll(user);
  }

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary:
      'Proves the enrolled device works; enables MFA and issues recovery codes.',
  })
  @ApiResponse({ status: 200, type: MfaConfirmResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid verification code.' })
  async confirm(
    @CurrentUser() user: User,
    @Body() dto: MfaCodeDto,
  ): Promise<MfaConfirmResponseDto> {
    const recoveryCodes = await this.mfaService.confirmEnrollment(
      user.id,
      dto.code,
    );
    return { recoveryCodes };
  }

  @Post('disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Disables MFA. Requires a current, valid TOTP code.',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 401, description: 'Invalid verification code.' })
  async disable(
    @CurrentUser() user: User,
    @Body() dto: MfaCodeDto,
  ): Promise<void> {
    await this.mfaService.disable(user.id, dto.code);
  }
}
