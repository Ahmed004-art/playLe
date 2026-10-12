import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { User } from '@prisma/client';
import { AuthService } from '../auth/auth.service.js';
import type { IssuedTokenPair } from '../auth/token.service.js';
import { UsersService } from '../users/users.service.js';
import { LoginDto } from '../auth/dto/login.dto.js';
import { MfaLoginVerifyDto } from '../auth/dto/mfa-login-verify.dto.js';
import {
  MfaChallengeResponseDto,
  UserResponseDto,
} from '../auth/dto/auth-response.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { AdminAuditService } from '../audit/admin-audit.service.js';
import {
  ADMIN_REFRESH_COOKIE,
  clearSessionCookies,
  getCookie,
  setSessionCookies,
} from './session-cookies.js';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../config/configuration.js';

const AUTH_THROTTLE = { auth: {} };

/**
 * httpOnly-cookie admin session endpoints — replaces storing the admin
 * dashboard's access/refresh tokens in `localStorage` (see
 * `docs/decisions/ADR-020-account-security.md`). Reuses the exact same
 * `AuthService`/`TokenService` rotating-refresh-token machinery every
 * other client already uses — this is a different *transport* for the
 * same session primitive, not a second auth system. Mutating routes here
 * are protected by the globally-registered `CsrfGuard`; brute-force
 * protection reuses the existing `auth` throttle profile.
 */
@ApiTags('admin-session')
@Controller({ path: 'admin/session', version: '1' })
export class AdminSessionController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly auditService: AdminAuditService,
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary:
      'Log in as an admin. Sets httpOnly session cookies; never returns ' +
      'a token in the response body.',
  })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiResponse({
    status: 200,
    type: MfaChallengeResponseDto,
    description: 'Returned instead when the account has MFA enrolled.',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid credentials, or not an admin.',
  })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserResponseDto | MfaChallengeResponseDto> {
    const meta = this.requestMeta(req);

    let result;
    try {
      result = await this.authService.login(dto, meta);
    } catch (error) {
      await this.auditService.record('LOGIN_FAILED', {
        detail: `identifier=${dto.identifier}`,
        ...meta,
      });
      throw error;
    }

    if ('mfaRequired' in result) return result;

    return this.finishAdminLogin(result, res, meta);
  }

  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary:
      'Completes an admin login that /admin/session/login paused for MFA.',
  })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiResponse({
    status: 401,
    description: 'Invalid/expired challenge, or an invalid TOTP/recovery code.',
  })
  async verifyMfa(
    @Body() dto: MfaLoginVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserResponseDto> {
    const meta = this.requestMeta(req);
    const result = await this.authService.completeMfaLogin(
      dto.mfaChallengeToken,
      dto.code,
      meta,
    );
    return this.finishAdminLogin(result, res, meta);
  }

  private async finishAdminLogin(
    result: { user: User } & IssuedTokenPair,
    res: Response,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<UserResponseDto> {
    if (result.user.role !== 'ADMIN') {
      // Revoke the session that was just issued — it must never be
      // usable, even though the credentials/MFA themselves were valid.
      await this.authService.logout(result.refreshToken, result.user.id);
      await this.auditService.record('LOGIN_FAILED', {
        adminId: result.user.id,
        detail: 'Valid credentials but not an admin account',
        ...meta,
      });
      // Same generic message as any other invalid-credentials case —
      // never reveals that the account exists but lacks admin rights.
      throw new UnauthorizedException('Invalid credentials');
    }

    setSessionCookies(res, result, {
      secureCookies: this.configService.get('adminSession.secureCookies', {
        infer: true,
      }),
      accessTokenCookieTtlMs: this.configService.get(
        'adminSession.accessTokenCookieTtlMs',
        { infer: true },
      ),
    });

    await this.auditService.record('LOGIN_SUCCESS', {
      adminId: result.user.id,
      ...meta,
    });

    return this.usersService.toSafeUser(result.user);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Rotates the admin session using the httpOnly refresh cookie. No ' +
      'request body — the refresh token never appears in JS-readable form.',
  })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiResponse({
    status: 401,
    description: 'Missing, expired, reused, or revoked session.',
  })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserResponseDto> {
    const rawRefreshToken = getCookie(req, ADMIN_REFRESH_COOKIE);

    if (!rawRefreshToken) {
      throw new UnauthorizedException('No admin session present');
    }

    const meta = this.requestMeta(req);
    const result = await this.authService.refresh(rawRefreshToken, meta);

    if (result.user.role !== 'ADMIN') {
      clearSessionCookies(res, {
        secureCookies: this.configService.get('adminSession.secureCookies', {
          infer: true,
        }),
      });
      throw new ForbiddenException('Not an admin account');
    }

    setSessionCookies(res, result, {
      secureCookies: this.configService.get('adminSession.secureCookies', {
        infer: true,
      }),
      accessTokenCookieTtlMs: this.configService.get(
        'adminSession.accessTokenCookieTtlMs',
        { infer: true },
      ),
    });

    await this.auditService.record('SESSION_REFRESH', {
      adminId: result.user.id,
      ...meta,
    });

    return this.usersService.toSafeUser(result.user);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Ends the admin session and clears its cookies.' })
  @ApiResponse({ status: 204 })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user: User,
  ): Promise<void> {
    const rawRefreshToken = getCookie(req, ADMIN_REFRESH_COOKIE);

    if (rawRefreshToken) {
      await this.authService.logout(rawRefreshToken, user.id);
    }

    clearSessionCookies(res, {
      secureCookies: this.configService.get('adminSession.secureCookies', {
        infer: true,
      }),
    });

    await this.auditService.record('LOGOUT', {
      adminId: user.id,
      ...this.requestMeta(req),
    });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The current admin session, if any.' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  me(@CurrentUser() user: User): UserResponseDto {
    return this.usersService.toSafeUser(user);
  }

  private requestMeta(req: Request): {
    ipAddress?: string;
    userAgent?: string;
  } {
    const header = req.headers['user-agent'] as string | string[] | undefined;
    return {
      ipAddress: req.ip,
      userAgent: Array.isArray(header) ? header[0] : header,
    };
  }
}
