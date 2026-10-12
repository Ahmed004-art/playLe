import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationOutbox, NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DELIVERY_PORT,
  type DeliveryPort,
} from '../notifications/ports/delivery.port.js';
import type { AppConfiguration } from '../config/configuration.js';

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 20;

const SUBJECTS: Record<NotificationType, string> = {
  DEPOSIT_COMPLETED: 'Your PlayLe deposit was completed',
  DEPOSIT_FAILED: 'Your PlayLe deposit failed',
  WITHDRAWAL_SUBMITTED: 'Your PlayLe withdrawal is being processed',
  WITHDRAWAL_COMPLETED: 'Your PlayLe withdrawal was completed',
  WITHDRAWAL_FAILED: 'Your PlayLe withdrawal failed',
  SELF_EXCLUSION_ACTIVATED:
    'You have self-excluded from PlayLe real-money play',
  PASSWORD_RESET_REQUESTED: 'Your PlayLe password reset code',
  VERIFICATION_CODE_ISSUED: 'Your PlayLe verification code',
};

/**
 * Polling dispatcher for `NotificationOutbox` — a plain `setInterval`
 * sweep, the same no-new-dependency pattern `MatchTimeoutService`
 * already established (`@nestjs/schedule` isn't installed and one
 * interval doesn't justify adding it). Only ever delivers a row that
 * was already committed by the financial transaction that created it —
 * this service never writes to `NotificationOutbox` itself.
 */
@Injectable()
export class NotificationDispatcherService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationDispatcherService.name);
  private interval: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DELIVERY_PORT) private readonly delivery: DeliveryPort,
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.configService.get(
      'notifications.dispatchSweepIntervalMs',
      { infer: true },
    );
    this.interval = setInterval(() => {
      this.sweep().catch((error: unknown) => {
        this.logger.error(
          `Notification dispatch sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
  }

  async sweep(): Promise<void> {
    const pending = await this.prisma.notificationOutbox.findMany({
      where: { status: 'PENDING', attempts: { lt: MAX_ATTEMPTS } },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
    });

    for (const notification of pending) {
      await this.dispatchOne(notification);
    }
  }

  private async dispatchOne(notification: NotificationOutbox): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: notification.userId },
      select: { email: true },
    });
    if (!user) {
      // The account no longer exists — nothing sensible to deliver.
      await this.prisma.notificationOutbox.update({
        where: { id: notification.id },
        data: { status: 'FAILED', failureReason: 'User no longer exists' },
      });
      return;
    }

    try {
      await this.delivery.send({
        channel: 'EMAIL',
        to: user.email,
        subject: SUBJECTS[notification.type],
        body: this.renderBody(notification),
      });
      await this.prisma.notificationOutbox.update({
        where: { id: notification.id },
        data: { status: 'SENT', sentAt: new Date() },
      });
    } catch (error) {
      const attempts = notification.attempts + 1;
      await this.prisma.notificationOutbox.update({
        where: { id: notification.id },
        data: {
          attempts,
          status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
          failureReason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private renderBody(notification: NotificationOutbox): string {
    const payload = notification.payload as Record<string, unknown>;
    const entries = Object.entries(payload)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join('\n');
    return entries || 'See your PlayLe account for details.';
  }
}
