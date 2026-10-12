import { randomBytes, createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { PasswordService } from '../auth/password.service.js';
import { TokenService } from '../auth/token.service.js';
import {
  normalizeEmail,
  normalizePhoneNumber,
} from '../auth/utils/phone.util.js';
import { AdminAuditService } from '../audit/admin-audit.service.js';
import {
  DELIVERY_PORT,
  type DeliveryPort,
} from '../notifications/ports/delivery.port.js';

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * Password reset — secure, hashed, expiring, single-use tokens;
 * deliberately anti-enumeration (the request endpoint's response never
 * reveals whether an account exists); resetting revokes every existing
 * session (same policy as `AuthService.changePassword`).
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly auditService: AdminAuditService,
    @Inject(DELIVERY_PORT) private readonly delivery: DeliveryPort,
  ) {}

  /**
   * Always resolves successfully regardless of whether the identifier
   * matches an account — the caller must show the same generic message
   * either way (see `PasswordResetController`).
   */
  async requestReset(identifier: string, requestIp?: string): Promise<void> {
    const normalized = identifier.includes('@')
      ? normalizeEmail(identifier)
      : (normalizePhoneNumber(identifier) ?? identifier);

    const user = await this.usersService.findByIdentifier(normalized);
    if (!user) return;

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = this.hashToken(rawToken);

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        requestIp,
      },
    });

    await this.delivery.send({
      channel: 'EMAIL',
      to: user.email,
      subject: 'Your PlayLe password reset code',
      body: `Your password reset code is: ${rawToken}\nThis code expires in 30 minutes. If you didn't request this, you can ignore it.`,
    });

    await this.auditService.record('PASSWORD_RESET_REQUESTED', {
      adminId: user.id,
    });
  }

  async confirmReset(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = this.hashToken(rawToken);
    const existing = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    // Same generic error whether the token is unknown, expired, or
    // already used — never reveals which.
    if (
      !existing ||
      existing.usedAt ||
      existing.expiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const newPasswordHash = await this.passwordService.hash(newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: existing.userId },
        data: { passwordHash: newPasswordHash },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: existing.id },
        data: { usedAt: new Date() },
      }),
    ]);

    // Revokes every existing session — same policy as
    // `AuthService.changePassword`.
    await this.tokenService.revokeAllForUser(existing.userId);

    await this.auditService.record('PASSWORD_RESET_COMPLETED', {
      adminId: existing.userId,
    });
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
