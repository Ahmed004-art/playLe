import { randomBytes, createHash } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { TokenService } from '../auth/token.service.js';
import { AdminAuditService } from '../audit/admin-audit.service.js';
import type { AppConfiguration } from '../config/configuration.js';
import { encryptSecret, decryptSecret } from './secret-encryption.util.js';
import { buildTotpUri, generateBase32Secret, verifyTotp } from './totp.util.js';

const RECOVERY_CODE_COUNT = 8;

export interface MfaEnrollmentResult {
  secret: string;
  otpauthUri: string;
}

/**
 * TOTP MFA: enrollment, confirmation, login-challenge verification, and
 * safe disablement. An unconfirmed credential enforces nothing — a user
 * can never be locked out by an *incomplete* enrollment, only by
 * deliberately completing one (see `confirmEnrollment`). Secrets are
 * encrypted at rest (`MFA_ENCRYPTION_KEY`) and never logged or returned
 * after the initial enrollment response.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly auditService: AdminAuditService,
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  private get encryptionKey(): string {
    return this.configService.get('security.mfaEncryptionKey', {
      infer: true,
    });
  }

  async isEnrolled(userId: string): Promise<boolean> {
    const credential = await this.prisma.mfaTotpCredential.findUnique({
      where: { userId },
    });
    return Boolean(credential?.confirmedAt && !credential.disabledAt);
  }

  /**
   * Starts (or resumes) enrollment. Resuming an already-started-but-
   * unconfirmed enrollment returns the *same* secret (so refreshing an
   * enrollment screen doesn't invalidate a code the user already
   * scanned) — only a confirmed credential is immutable from here.
   */
  async enroll(user: Pick<User, 'id' | 'email'>): Promise<MfaEnrollmentResult> {
    const existing = await this.prisma.mfaTotpCredential.findUnique({
      where: { userId: user.id },
    });

    if (existing?.confirmedAt && !existing.disabledAt) {
      throw new BadRequestException(
        'MFA is already enabled — disable it before re-enrolling',
      );
    }

    const secret =
      existing && !existing.confirmedAt
        ? decryptSecret(existing.secretEncrypted, this.encryptionKey)
        : generateBase32Secret();

    await this.prisma.mfaTotpCredential.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        secretEncrypted: encryptSecret(secret, this.encryptionKey),
      },
      update: {
        secretEncrypted: encryptSecret(secret, this.encryptionKey),
        confirmedAt: null,
        disabledAt: null,
      },
    });

    return {
      secret,
      otpauthUri: buildTotpUri({
        secret,
        accountName: user.email,
        issuer: 'PlayLe',
      }),
    };
  }

  /** Proves the enrolled device actually works before MFA starts being enforced. */
  async confirmEnrollment(userId: string, code: string): Promise<string[]> {
    const credential = await this.prisma.mfaTotpCredential.findUnique({
      where: { userId },
    });
    if (!credential || credential.confirmedAt) {
      throw new BadRequestException('No pending MFA enrollment');
    }

    const secret = decryptSecret(
      credential.secretEncrypted,
      this.encryptionKey,
    );
    if (!verifyTotp(secret, code)) {
      throw new UnauthorizedException('Invalid verification code');
    }

    const rawCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      randomBytes(5).toString('hex'),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.mfaTotpCredential.update({
        where: { userId },
        data: { confirmedAt: new Date() },
      });
      await tx.mfaRecoveryCode.deleteMany({
        where: { mfaTotpCredentialId: credential.id },
      });
      await tx.mfaRecoveryCode.createMany({
        data: rawCodes.map((code) => ({
          mfaTotpCredentialId: credential.id,
          codeHash: this.hashRecoveryCode(code),
        })),
      });
    });

    await this.auditService.record('MFA_ENROLLED', { adminId: userId });

    return rawCodes;
  }

  /** Requires a fresh valid TOTP code — a stolen access token alone cannot turn MFA off. */
  async disable(userId: string, code: string): Promise<void> {
    const credential = await this.prisma.mfaTotpCredential.findUnique({
      where: { userId },
    });
    if (!credential?.confirmedAt || credential.disabledAt) {
      throw new BadRequestException('MFA is not enabled');
    }

    const secret = decryptSecret(
      credential.secretEncrypted,
      this.encryptionKey,
    );
    if (!verifyTotp(secret, code)) {
      throw new UnauthorizedException('Invalid verification code');
    }

    await this.prisma.mfaTotpCredential.update({
      where: { userId },
      data: { disabledAt: new Date() },
    });

    await this.auditService.record('MFA_DISABLED', { adminId: userId });
  }

  /**
   * Verifies a login-time MFA challenge (issued by `AuthService.login`
   * via `TokenService.signMfaChallengeToken` when the account has MFA
   * enrolled). Accepts either a current TOTP code or a single-use
   * recovery code — never both consumed for one successful call.
   */
  async verifyChallenge(
    mfaChallengeToken: string,
    code: string,
  ): Promise<User> {
    const userId = this.tokenService.verifyMfaChallengeToken(mfaChallengeToken);

    const credential = await this.prisma.mfaTotpCredential.findUnique({
      where: { userId },
      include: { recoveryCodes: true },
    });
    if (!credential?.confirmedAt || credential.disabledAt) {
      throw new UnauthorizedException('MFA is not enabled for this account');
    }

    const secret = decryptSecret(
      credential.secretEncrypted,
      this.encryptionKey,
    );
    const normalizedCode = code.trim();

    if (!verifyTotp(secret, normalizedCode)) {
      const matchedRecoveryCode = credential.recoveryCodes.find(
        (recoveryCode) =>
          !recoveryCode.usedAt &&
          recoveryCode.codeHash === this.hashRecoveryCode(normalizedCode),
      );

      if (!matchedRecoveryCode) {
        await this.auditService.record('MFA_CHALLENGE_FAILED', {
          adminId: userId,
        });
        throw new UnauthorizedException('Invalid verification code');
      }

      await this.prisma.mfaRecoveryCode.update({
        where: { id: matchedRecoveryCode.id },
        data: { usedAt: new Date() },
      });
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    return user;
  }

  private hashRecoveryCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }
}
