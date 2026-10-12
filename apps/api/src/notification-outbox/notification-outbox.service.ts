import { Injectable } from '@nestjs/common';
import { Prisma, type NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Transactional outbox writer. `enqueue` must always be called with the
 * *same* `tx` the caller's financial mutation is already using — see
 * ADR-019 "notifications must not be emitted as successful financial
 * outcomes before the underlying transaction commits". A row written
 * here is only ever delivered later, by `NotificationDispatcherService`,
 * never synchronously — delivery failure never rolls back or retries
 * the financial operation that produced it.
 */
@Injectable()
export class NotificationOutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(
    tx: Prisma.TransactionClient,
    params: {
      userId: string;
      type: NotificationType;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.notificationOutbox.create({
      data: {
        userId: params.userId,
        type: params.type,
        payload: params.payload as Prisma.InputJsonValue,
      },
    });
  }

  /** For call sites with no existing transaction (e.g. a plain `update`, not a `$transaction`). */
  async enqueueStandalone(params: {
    userId: string;
    type: NotificationType;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.enqueue(this.prisma, params);
  }
}
