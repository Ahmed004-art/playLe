import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  ResponsibleGamingRestriction,
  ResponsibleGamingRestrictionType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationOutboxService } from '../notification-outbox/notification-outbox.service.js';

/**
 * Self-service responsible-gaming controls — self-exclusion, deposit/
 * stake/loss limits, cooling-off. Every change is a *new* row, never a
 * destructive edit of a prior one (see the model's doc comment in
 * schema.prisma) — the full history is always reconstructable.
 *
 * Self-exclusion deliberately has **no lift method anywhere in this
 * class, this module, or the admin surface** — see ADR-021. Absent a
 * defined, legally-authorized compliance-officer role and process, the
 * only safe default is that nothing in this codebase can silently (or
 * even deliberately, via an ordinary admin action) turn it back off.
 */
@Injectable()
export class ResponsibleGamingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationOutbox: NotificationOutboxService,
  ) {}

  async getActiveRestrictions(
    userId: string,
  ): Promise<ResponsibleGamingRestriction[]> {
    return this.prisma.responsibleGamingRestriction.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async isSelfExcluded(userId: string): Promise<boolean> {
    const restrictions = await this.getActiveRestrictions(userId);
    return restrictions.some((r) => r.type === 'SELF_EXCLUSION');
  }

  /**
   * Permanent and irreversible within this codebase (see class doc).
   * Rejects a second call once already active — not because a repeat
   * request is harmful, but to make the one-way nature explicit to the
   * caller rather than silently no-op.
   */
  async selfExclude(userId: string): Promise<ResponsibleGamingRestriction> {
    if (await this.isSelfExcluded(userId)) {
      throw new BadRequestException('Self-exclusion is already active');
    }
    const restriction = await this.prisma.responsibleGamingRestriction.create({
      data: { userId, type: 'SELF_EXCLUSION', config: {} },
    });
    await this.notificationOutbox.enqueueStandalone({
      userId,
      type: 'SELF_EXCLUSION_ACTIVATED',
      payload: { restrictionId: restriction.id },
    });
    return restriction;
  }

  async startCoolingOff(
    userId: string,
    durationMinutes: number,
  ): Promise<ResponsibleGamingRestriction> {
    await this.supersede(userId, 'COOLING_OFF');
    return this.prisma.responsibleGamingRestriction.create({
      data: {
        userId,
        type: 'COOLING_OFF',
        config: {},
        endsAt: new Date(Date.now() + durationMinutes * 60 * 1000),
      },
    });
  }

  async setDepositLimit(
    userId: string,
    limitMinor: bigint,
  ): Promise<ResponsibleGamingRestriction> {
    return this.setAmountLimit(userId, 'DEPOSIT_LIMIT', limitMinor);
  }

  async setStakeLimit(
    userId: string,
    limitMinor: bigint,
  ): Promise<ResponsibleGamingRestriction> {
    return this.setAmountLimit(userId, 'STAKE_LIMIT', limitMinor);
  }

  async setLossLimit(
    userId: string,
    limitMinor: bigint,
  ): Promise<ResponsibleGamingRestriction> {
    return this.setAmountLimit(userId, 'LOSS_LIMIT', limitMinor);
  }

  private async setAmountLimit(
    userId: string,
    type: ResponsibleGamingRestrictionType,
    limitMinor: bigint,
  ): Promise<ResponsibleGamingRestriction> {
    await this.supersede(userId, type);
    return this.prisma.responsibleGamingRestriction.create({
      data: {
        userId,
        type,
        config: { limitMinor: limitMinor.toString() },
      },
    });
  }

  /** Marks any still-ACTIVE restriction of this type EXPIRED — a new row always follows. */
  private async supersede(
    userId: string,
    type: ResponsibleGamingRestrictionType,
  ): Promise<void> {
    await this.prisma.responsibleGamingRestriction.updateMany({
      where: { userId, type, status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });
  }

  /** Admin visibility only — read-only, no override/lift action exposed. */
  async listHistoryAdmin(params: {
    userId?: string;
  }): Promise<ResponsibleGamingRestriction[]> {
    return this.prisma.responsibleGamingRestriction.findMany({
      where: params.userId ? { userId: params.userId } : {},
      orderBy: { createdAt: 'desc' },
    });
  }
}
