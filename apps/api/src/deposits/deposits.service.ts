import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Deposit } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProviderPort,
  type WebhookDepositPayload,
} from '../payments/ports/payment-provider.port.js';
import { parseAmountMinor } from '../common/money.js';
import type { CursorPage } from '../common/dto/pagination.dto.js';
import type { AppConfiguration } from '../config/configuration.js';

@Injectable()
export class DepositsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly walletService: WalletService,
    private readonly configService: ConfigService<AppConfiguration, true>,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderPort,
  ) {}

  async create(
    userId: string,
    amountMinorStr: string,
    idempotencyKey: string,
  ): Promise<Deposit> {
    const amountMinor = parseAmountMinor(amountMinorStr);
    const minDeposit = this.configService.get('payments.minDepositMinor', {
      infer: true,
    });

    if (amountMinor < minDeposit) {
      throw new UnprocessableEntityException(
        `Minimum deposit is ${minDeposit} minor units`,
      );
    }

    const wallet = await this.walletService.getByUserId(userId);

    let deposit: Deposit;
    try {
      deposit = await this.prisma.deposit.create({
        data: {
          userId,
          walletId: wallet.id,
          amountMinor,
          provider: this.provider.name,
          idempotencyKey,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Idempotent retry: the same user + idempotency key already
        // created a deposit — return the original, not an error.
        const existing = await this.prisma.deposit.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
        });
        if (existing) return existing;
      }
      throw error;
    }

    const initiation = await this.provider.initiateDeposit({
      depositId: deposit.id,
      userId,
      amountMinor,
      currency: deposit.currency,
    });

    if (initiation.providerReference) {
      deposit = await this.prisma.deposit.update({
        where: { id: deposit.id },
        data: { providerReference: initiation.providerReference },
      });
    }

    return deposit;
  }

  async findById(userId: string, id: string): Promise<Deposit> {
    const deposit = await this.prisma.deposit.findUnique({ where: { id } });
    if (!deposit || deposit.userId !== userId) {
      throw new NotFoundException('Deposit not found');
    }
    return deposit;
  }

  async list(
    userId: string,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<Deposit>> {
    return this.listInternal({ userId }, { cursor, limit });
  }

  /** Admin visibility: optionally filtered by user, otherwise every user's deposits. */
  async listAdmin(params: {
    userId?: string;
    cursor?: string;
    limit: number;
  }): Promise<CursorPage<Deposit>> {
    const { cursor, limit, userId } = params;
    return this.listInternal(userId ? { userId } : {}, { cursor, limit });
  }

  private async listInternal(
    where: Prisma.DepositWhereInput,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<Deposit>> {
    const deposits = await this.prisma.deposit.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = deposits.length > limit;
    const items = hasMore ? deposits.slice(0, limit) : deposits;

    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /**
   * Credits the ledger from a **verified** provider event. Never callable
   * from client input directly — only from the webhook handler after
   * `PaymentProviderPort.verifyWebhookSignature` has succeeded. Idempotent:
   * a deposit that is no longer PENDING is returned unchanged.
   */
  async completeFromProviderEvent(
    depositId: string,
    providerReference: string | undefined,
  ): Promise<Deposit> {
    const existing = await this.prisma.deposit.findUnique({
      where: { id: depositId },
    });
    if (!existing) {
      throw new NotFoundException('Deposit not found');
    }
    if (existing.status !== 'PENDING') {
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
      const walletId = await this.walletService.getWalletIdForUser(
        tx,
        existing.userId,
      );

      await this.ledgerService.applyEntry(tx, walletId, {
        type: 'DEPOSIT',
        availableDeltaMinor: existing.amountMinor,
        heldDeltaMinor: 0n,
        currency: existing.currency,
        relatedDepositId: existing.id,
        providerReference,
      });

      return tx.deposit.update({
        where: { id: existing.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          providerReference: providerReference ?? existing.providerReference,
        },
      });
    });
  }

  async markFailed(depositId: string, reason: string): Promise<Deposit> {
    const existing = await this.prisma.deposit.findUnique({
      where: { id: depositId },
    });
    if (!existing) {
      throw new NotFoundException('Deposit not found');
    }
    if (existing.status !== 'PENDING') {
      return existing;
    }

    return this.prisma.deposit.update({
      where: { id: existing.id },
      data: { status: 'FAILED', failedAt: new Date(), failureReason: reason },
    });
  }

  getProvider(): PaymentProviderPort {
    return this.provider;
  }

  async findByProviderReference(
    providerReference: string,
  ): Promise<Deposit | null> {
    if (!providerReference) {
      throw new BadRequestException('providerReference is required');
    }
    return this.prisma.deposit.findFirst({ where: { providerReference } });
  }

  /**
   * Entry point for `POST /payments/webhooks/monime`. Verifies
   * authenticity first (fails closed for an unverified/real Monime
   * signature — see MonimeProvider), records every delivery attempt in
   * `ProviderEvent` for idempotency + audit, and only then applies any
   * ledger effect. A duplicate delivery (same provider + event id) is a
   * no-op by database constraint, not application logic.
   */
  async processProviderWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<'processed' | 'ignored' | 'rejected'> {
    const verification = this.provider.verifyWebhookSignature(rawBody, headers);

    if (!verification.valid || !verification.providerEventId) {
      return 'rejected';
    }

    let providerEvent;
    try {
      providerEvent = await this.prisma.providerEvent.create({
        data: {
          provider: this.provider.name,
          providerEventId: verification.providerEventId,
          eventType: verification.eventType ?? 'unknown',
          payload: verification.parsedPayload ?? {},
          status: 'RECEIVED',
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Already seen this exact provider event before — duplicate
        // delivery, safely ignored.
        return 'ignored';
      }
      throw error;
    }

    const payload = this.asDepositPayload(verification.parsedPayload);
    const deposit = payload
      ? await this.findByProviderReference(payload.providerReference)
      : null;

    if (!payload || !deposit) {
      await this.prisma.providerEvent.update({
        where: { id: providerEvent.id },
        data: { status: 'IGNORED', processedAt: new Date() },
      });
      return 'ignored';
    }

    if (payload.eventType === 'deposit.completed') {
      await this.completeFromProviderEvent(
        deposit.id,
        payload.providerReference,
      );
    } else if (payload.eventType === 'deposit.failed') {
      await this.markFailed(
        deposit.id,
        payload.reason ?? 'Provider reported a failed deposit',
      );
    }

    await this.prisma.providerEvent.update({
      where: { id: providerEvent.id },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
        relatedDepositId: deposit.id,
      },
    });

    return 'processed';
  }

  private asDepositPayload(value: unknown): WebhookDepositPayload | null {
    if (
      value &&
      typeof value === 'object' &&
      'eventType' in value &&
      'providerReference' in value &&
      ((value as WebhookDepositPayload).eventType === 'deposit.completed' ||
        (value as WebhookDepositPayload).eventType === 'deposit.failed') &&
      typeof (value as WebhookDepositPayload).providerReference === 'string'
    ) {
      return value as WebhookDepositPayload;
    }
    return null;
  }
}
