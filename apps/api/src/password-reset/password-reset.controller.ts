import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { PasswordResetService } from './password-reset.service.js';
import {
  ConfirmPasswordResetDto,
  RequestPasswordResetDto,
} from './dto/password-reset.dto.js';

const AUTH_THROTTLE = { auth: {} };

/** Deliberately unauthenticated — this is how a locked-out user gets back in. */
@ApiTags('password-reset')
@Controller({ path: 'auth/password-reset', version: '1' })
export class PasswordResetController {
  constructor(private readonly passwordResetService: PasswordResetService) {}

  @Post('request')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary:
      'Requests a password reset code. Always returns the same generic ' +
      'response, whether or not the identifier matches an account.',
  })
  @ApiResponse({ status: 200 })
  async request(
    @Body() dto: RequestPasswordResetDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    await this.passwordResetService.requestReset(dto.identifier, req.ip);
    return {
      message:
        'If an account exists for that identifier, a reset code has been sent.',
    };
  }

  @Post('confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary:
      'Completes a password reset. Revokes every existing session for the account.',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 400, description: 'Invalid or expired reset token.' })
  async confirm(@Body() dto: ConfirmPasswordResetDto): Promise<void> {
    await this.passwordResetService.confirmReset(dto.token, dto.newPassword);
  }
}
