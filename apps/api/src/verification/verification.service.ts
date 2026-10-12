import { randomInt, createHash } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { User, VerificationChannel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DELIVERY_PORT,
  type DeliveryPort,
} from '../notifications/ports/delivery.port.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/**
 * Email/phone verification via a one-time numeric code. The schema
 * placeholder (`User.emailVerifiedAt`/`phoneVerifiedAt`) has existed
 * since Phase 2 — this is the first code path that actually sets it
 * (see CLAUDE.md "Email/SMS verification has a schema placeholder but
 * no provider integration or OTP flow" — the OTP flow itself is now
 * real; only the *delivery* is still `FakeDeliveryAdapter`, see
 * docs/development/PHASE_6_CHECKLIST.md item 6).
 */
@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DELIVERY_PORT) private readonly delivery: DeliveryPort,
  ) {}

  async requestChallenge(
    user: User,
    channel: VerificationChannel,
  ): Promise<void> {
    const purpose =
      channel === 'EMAIL' ? 'EMAIL_VERIFICATION' : 'PHONE_VERIFICATION';
    const target = channel === 'EMAIL' ? user.email : user.phoneNumber;

    if (!target) {
      throw new BadRequestException(
        channel === 'EMAIL' ? 'No email on file' : 'No phone number on file',
      );
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = this.hashCode(code);

    await this.prisma.$transaction([
      // Superseding any still-open prior challenge for this purpose
      // avoids an old code staying valid alongside a newer one.
      this.prisma.verificationChallenge.updateMany({
        where: { userId: user.id, purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      this.prisma.verificationChallenge.create({
        data: {
          userId: user.id,
          channel,
          purpose,
          target,
          codeHash,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        },
      }),
    ]);

    await this.delivery.send({
      channel,
      to: target,
      subject: 'Your PlayLe verification code',
      body: `Your verification code is: ${code}\nThis code expires in 10 minutes.`,
    });
  }

  async confirmChallenge(
    user: User,
    channel: VerificationChannel,
    code: string,
  ): Promise<void> {
    const purpose =
      channel === 'EMAIL' ? 'EMAIL_VERIFICATION' : 'PHONE_VERIFICATION';

    const challenge = await this.prisma.verificationChallenge.findFirst({
      where: { userId: user.id, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('No active verification challenge');
    }

    if (challenge.attempts >= MAX_ATTEMPTS) {
      await this.prisma.verificationChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });
      throw new UnauthorizedException('Too many attempts — request a new code');
    }

    if (challenge.codeHash !== this.hashCode(code)) {
      await this.prisma.verificationChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Invalid verification code');
    }

    await this.prisma.$transaction([
      this.prisma.verificationChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data:
          channel === 'EMAIL'
            ? { emailVerifiedAt: new Date() }
            : { phoneVerifiedAt: new Date() },
      }),
    ]);
  }

  private hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }
}
