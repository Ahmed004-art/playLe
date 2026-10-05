import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { User, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AppConfiguration } from '../config/configuration.js';

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
}

export interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

interface RefreshMeta {
  userAgent?: string;
  ipAddress?: string;
}

/**
 * Issues and verifies access tokens, and issues/rotates/revokes refresh
 * tokens. See ADR-011 for the full strategy. Key points:
 *
 * - Access tokens are short-lived JWTs (default 15m) signed with
 *   JWT_ACCESS_SECRET. The payload is minimal: user id + role only —
 *   never a password, and nothing that goes stale badly if the user's
 *   profile changes mid-token-lifetime.
 * - Refresh tokens are NOT JWTs. They're opaque, cryptographically random
 *   strings. Only a SHA-256 hash of a refresh token is ever persisted
 *   (see the `RefreshToken` Prisma model), so a database read alone can
 *   never produce a usable token.
 * - Refresh tokens rotate on every use: presenting one issues a new one
 *   in the same `familyId` and revokes the presented one. Presenting an
 *   already-revoked token is reuse of a stale token (e.g. a stolen,
 *   previously-used one) and revokes the entire family — logging out
 *   every session descended from that original login.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfiguration, true>,
    private readonly prisma: PrismaService,
  ) {}

  signAccessToken(user: Pick<User, 'id' | 'role'>): string {
    const payload: AccessTokenPayload = { sub: user.id, role: user.role };

    return this.jwtService.sign(payload, {
      secret: this.configService.get('auth.accessTokenSecret', { infer: true }),
      expiresIn: this.configService.get('auth.accessTokenTtl', { infer: true }),
    });
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    try {
      return this.jwtService.verify<AccessTokenPayload>(token, {
        secret: this.configService.get('auth.accessTokenSecret', {
          infer: true,
        }),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  async issueRefreshToken(
    userId: string,
    familyId: string = randomUUID(),
    meta: RefreshMeta = {},
  ): Promise<{ token: string; expiresAt: Date; familyId: string }> {
    const rawToken = this.generateRawToken();
    const tokenHash = this.hashToken(rawToken);
    const ttlDays = this.configService.get('auth.refreshTokenTtlDays', {
      infer: true,
    });
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        familyId,
        expiresAt,
        userAgent: meta.userAgent,
        ipAddress: meta.ipAddress,
      },
    });

    return { token: rawToken, expiresAt, familyId };
  }

  async issueTokenPair(
    user: Pick<User, 'id' | 'role'>,
    meta: RefreshMeta = {},
  ): Promise<IssuedTokenPair> {
    const accessToken = this.signAccessToken(user);
    const refresh = await this.issueRefreshToken(user.id, undefined, meta);

    return {
      accessToken,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt,
    };
  }

  /**
   * Validates and rotates a presented refresh token. Throws
   * UnauthorizedException for any invalid, expired, revoked (reused), or
   * unknown token.
   */
  async rotateRefreshToken(
    rawToken: string,
    meta: RefreshMeta = {},
  ): Promise<IssuedTokenPair & { user: User }> {
    const tokenHash = this.hashToken(rawToken);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!existing) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existing.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token has already been used');
    }

    if (existing.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    const next = await this.issueRefreshToken(
      existing.userId,
      existing.familyId,
      meta,
    );

    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: {
        revokedAt: new Date(),
        replacedByHash: this.hashToken(next.token),
      },
    });

    return {
      accessToken: this.signAccessToken(existing.user),
      refreshToken: next.token,
      refreshTokenExpiresAt: next.expiresAt,
      user: existing.user,
    };
  }

  /** Revokes one specific refresh token, scoped to its owning user (logout). */
  async revokeRefreshToken(rawToken: string, userId: string): Promise<boolean> {
    const tokenHash = this.hashToken(rawToken);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!existing || existing.userId !== userId || existing.revokedAt) {
      return false;
    }

    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    return true;
  }

  /** Revokes every active session for a user (e.g. on password change). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private generateRawToken(): string {
    return randomBytes(48).toString('base64url');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
