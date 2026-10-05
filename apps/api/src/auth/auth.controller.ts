import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { User } from '@prisma/client';
import { AuthService } from './auth.service.js';
import { UsersService } from '../users/users.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshDto } from './dto/refresh.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { CurrentUser } from './decorators/current-user.decorator.js';

/**
 * Uses the separately-configurable 'auth' throttler profile registered in
 * AppModule (stricter than the global default, since these routes are
 * credential-guessing-sensitive) — see AUTH_THROTTLE_LIMIT/AUTH_THROTTLE_TTL_MS.
 */
const AUTH_THROTTLE = { auth: {} };

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Post('register')
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({ summary: 'Create a new PlayLe account.' })
  @ApiResponse({ status: 201, type: AuthResponseDto })
  @ApiResponse({
    status: 409,
    description: 'Email, username, or phone number already in use.',
  })
  @ApiResponse({
    status: 422,
    description: 'Under the minimum age, or an invalid phone number.',
  })
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    const result = await this.authService.register(dto, this.requestMeta(req));
    return this.toAuthResponse(result);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Log in with an email or phone number, plus password.',
  })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({
    status: 401,
    description: 'Invalid credentials, or the account is suspended/disabled.',
  })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const result = await this.authService.login(dto, this.requestMeta(req));
    return this.toAuthResponse(result);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new access/refresh token pair.',
  })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({
    status: 401,
    description: 'Invalid, expired, reused, or revoked refresh token.',
  })
  async refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    const result = await this.authService.refresh(
      dto.refreshToken,
      this.requestMeta(req),
    );
    return this.toAuthResponse(result);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Revoke the given refresh token (ends that session).',
  })
  @ApiResponse({ status: 204, description: 'Session ended.' })
  async logout(
    @Body() dto: RefreshDto,
    @CurrentUser() user: User,
  ): Promise<void> {
    await this.authService.logout(dto.refreshToken, user.id);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "The authenticated user's own account information.",
  })
  @ApiResponse({ status: 200, type: UserResponseDto })
  me(@CurrentUser() user: User): UserResponseDto {
    return this.usersService.toSafeUser(user);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Change the authenticated user’s password. Revokes all existing sessions.',
  })
  @ApiResponse({
    status: 204,
    description: 'Password changed; re-authentication is required.',
  })
  @ApiResponse({ status: 401, description: 'Current password is incorrect.' })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: User,
  ): Promise<void> {
    await this.authService.changePassword(user, dto);
  }

  private requestMeta(req: Request): {
    userAgent?: string;
    ipAddress?: string;
  } {
    const header = req.headers['user-agent'] as string | string[] | undefined;
    const userAgent: string | undefined = Array.isArray(header)
      ? header[0]
      : header;
    const ipAddress: string | undefined = req.ip;

    return { userAgent, ipAddress };
  }

  private toAuthResponse(result: {
    user: User;
    accessToken: string;
    refreshToken: string;
    refreshTokenExpiresAt: Date;
  }): AuthResponseDto {
    return {
      user: this.usersService.toSafeUser(result.user),
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
    };
  }
}
