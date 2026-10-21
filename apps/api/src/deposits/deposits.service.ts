import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
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
import { FINANCIAL_TRANSACTION_OPTIONS } from '../common/prisma-transaction.constants.js';
import type { CursorPage } from '../common/dto/pagination.dto.js';
import type { AppConfiguration } from '../config/configuration.js';
import { EligibilityService } from '../eligibility/eligibility.service.js';
import { NotificationOutboxService } from '../notification-outbox/notification-outbox.service.js';

export interface DepositPaymentInstructions {
  ussdCode?: string;
  expiresAt?: string;
}

@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly walletService: WalletService,
    private readonly configService: ConfigService<AppConfiguration, true>,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderPort,
    private readonly eligibilityService: EligibilityService,
    private readonly notificationOutbox: NotificationOutboxService,
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

    await this.eligibilityService.assertCanDeposit(userId, amountMinor);

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

    const providerIdempotencyKey = randomUUID();
    const operation = await this.prisma.providerOperation.create({
      data: {
        provider: this.provider.name,
        kind: 'DEPOSIT_INITIATE',
        relatedDepositId: deposit.id,
        providerIdempotencyKey,
        status: 'PENDING',
      },
    });

    let initiation;
    try {
      initiation = await this.provider.initiateDeposit({
        depositId: deposit.id,
        userId,
        amountMinor,
        currency: deposit.currency,
        providerIdempotencyKey,
      });
    } catch (error) {
      // Nothing financial has moved yet (a deposit only ever credits via
      // a *verified* webhook) — an ambiguous initiation failure here just
      // means the user won't have a working payment code and should
      // retry, not a stuck/duplicate-risk financial operation like a
      // payout. Recorded as UNKNOWN for audit, deposit stays PENDING.
      this.logger.error(
        `Deposit initiation for ${deposit.id} ended in an unknown outcome: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.prisma.providerOperation.update({
        where: { id: operation.id },
        data: {
          status: 'UNKNOWN',
          failureReason:
            error instanceof Error ? error.message : 'Unknown error',
        },
      });
      return deposit;
    }

    await this.prisma.providerOperation.update({
      where: { id: operation.id },
      data: {
        status: initiation.status === 'PENDING' ? 'SUCCEEDED' : 'FAILED',
        responseSnapshot: {
          raw: (initiation.raw ?? null) as Prisma.InputJsonValue,
          userFacingInstructions: initiation.userFacingInstructions ?? null,
        },
        resolvedAt: new Date(),
      },
    });

    if (initiation.providerReference) {
      deposit = await this.prisma.deposit.update({
        where: { id: deposit.id },
        data: { providerReference: initiation.providerReference },
      });
    }

    return deposit;
  }

  /**
   * The most recent provider-facing instructions for a deposit (e.g. a
   * USSD code to dial and when it expires) — safe, non-secret data
   * surfaced to the client. Returns `null` for a `MANUAL` deposit or
   * whenever no provider call produced any (e.g. `UNAVAILABLE`).
   */
  async getPaymentInstructions(
    depositId: string,
  ): Promise<DepositPaymentInstructions | null> {
    const operation = await this.prisma.providerOperation.findFirst({
      where: { relatedDepositId: depositId, kind: 'DEPOSIT_INITIATE' },
      orderBy: { createdAt: 'desc' },
    });
    const snapshot = operation?.responseSnapshot as
      | { userFacingInstructions?: DepositPaymentInstructions | null }
      | null
      | undefined;
    return snapshot?.userFacingInstructions ?? null;
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
   * a deposit that is no longer PENDING is returned unchanged, and a deposit
   * is credited at most once however many distinct provider events (or
   * concurrent callers) confirm it - the unique `ProviderEvent` id only
   * stops a *repeated* event, so the exactly-once guarantee has to live here.
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

      // Claim the deposit: PENDING -> COMPLETED only if it is *still* PENDING.
      // The status read above ran outside this transaction, so two
      // completions can both have seen PENDING. The conditional update takes
      // the row lock, so the second one waits for the first to commit and then
      // matches no row (READ COMMITTED re-evaluates the WHERE) - and only the
      // transaction that claimed the row credits the wallet.
      const { count } = await tx.deposit.updateMany({
        where: { id: existing.id, status: 'PENDING' },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          providerReference: providerReference ?? existing.providerReference,
        },
      });
      if (count === 0) {
        // Already completed (or failed/expired) by a concurrent event: no
        // credit, no notification - return the deposit as it now stands.
        return tx.deposit.findUniqueOrThrow({ where: { id: existing.id } });
      }

      await this.ledgerService.applyEntry(tx, walletId, {
        type: 'DEPOSIT',
        availableDeltaMinor: existing.amountMinor,
        heldDeltaMinor: 0n,
        currency: existing.currency,
        relatedDepositId: existing.id,
        providerReference,
      });

      // Same transaction as the ledger write above — never emitted
      // before this commits (see ADR-019).
      await this.notificationOutbox.enqueue(tx, {
        userId: existing.userId,
        type: 'DEPOSIT_COMPLETED',
        payload: {
          depositId: existing.id,
          amountMinor: existing.amountMinor.toString(),
          currency: existing.currency,
        },
      });

      return tx.deposit.findUniqueOrThrow({ where: { id: existing.id } });
    }, FINANCIAL_TRANSACTION_OPTIONS);
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

    return this.prisma.$transaction(async (tx) => {
      // Claim: PENDING -> FAILED only if the deposit is *still* PENDING. The
      // read above ran outside this transaction, so a completion may have
      // committed since; an unconditional update would overwrite it and
      // leave a credited wallet behind a FAILED deposit. The conditional
      // update takes the row lock, so against an open completion it waits and
      // then matches no row.
      const { count } = await tx.deposit.updateMany({
        where: { id: existing.id, status: 'PENDING' },
        data: { status: 'FAILED', failedAt: new Date(), failureReason: reason },
      });
      if (count === 0) {
        // Lost to a concurrent transition: no overwrite, no failure notice.
        return tx.deposit.findUniqueOrThrow({ where: { id: existing.id } });
      }

      // Same transaction as the status change - the notice exists if and
      // only if the deposit really became FAILED (see ADR-019).
      await this.notificationOutbox.enqueue(tx, {
        userId: existing.userId,
        type: 'DEPOSIT_FAILED',
        payload: {
          depositId: existing.id,
          amountMinor: existing.amountMinor.toString(),
          currency: existing.currency,
          reason,
        },
      });

      return tx.deposit.findUniqueOrThrow({ where: { id: existing.id } });
    }, FINANCIAL_TRANSACTION_OPTIONS);
  }

  /**
   * The provider-side payment code/session expired before the user paid
   * — distinct from `FAILED` (which implies the provider actively
   * rejected or reversed something). No ledger effect either way.
   */
  async markExpired(depositId: string): Promise<Deposit> {
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
      // Same conditional claim as `markFailed`: never overwrite a deposit a
      // concurrent completion (or failure) has already moved off PENDING.
      await tx.deposit.updateMany({
        where: { id: existing.id, status: 'PENDING' },
        data: { status: 'EXPIRED', failedAt: new Date() },
      });
      return tx.deposit.findUniqueOrThrow({ where: { id: existing.id } });
    }, FINANCIAL_TRANSACTION_OPTIONS);
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
      // A provider that reports what was paid must agree with the deposit
      // before anything is claimed or credited: the credit is always the
      // deposit's own stored amount, so an unchecked completion for a
      // different amount or currency would credit money that was never paid.
      // A rejected event leaves the deposit PENDING (not FAILED, not
      // refunded) so a later valid event can still complete it, and is kept
      // as REJECTED against the deposit for operators - see
      // `PaymentReconciliationService.findRejectedCompletions`.
      const problem = this.reportedPaymentProblem(
        verification.parsedPayload,
        deposit,
      );
      if (problem) {
        this.logger.warn(
          `Rejected completion event ${verification.providerEventId} for deposit ${deposit.id}: ${problem}. Deposit left PENDING.`,
        );
        await this.prisma.providerEvent.update({
          where: { id: providerEvent.id },
          data: {
            status: 'REJECTED',
            processedAt: new Date(),
            relatedDepositId: deposit.id,
          },
        });
        return 'rejected';
      }

      await this.completeFromProviderEvent(
        deposit.id,
        payload.providerReference,
      );
    } else if (payload.eventType === 'deposit.failed') {
      await this.markFailed(
        deposit.id,
        payload.reason ?? 'Provider reported a failed deposit',
      );
    } else if (payload.eventType === 'deposit.expired') {
      await this.markExpired(deposit.id);
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

  /**
   * Checks the amount and currency a provider reported on a completion event
   * against the deposit, returning why it must be rejected or `null` if it may
   * proceed. Neither field present = a provider that does not report them
   * (legacy behaviour). Otherwise both must be present and well-formed - the
   * amount a canonical non-negative decimal-integer STRING (validated before
   * any BigInt conversion; a JS number is refused outright because it cannot
   * represent every minor-unit amount), the currency an upper-case 3-letter
   * code - and both must equal the deposit's.
   */
  private reportedPaymentProblem(
    parsedPayload: unknown,
    deposit: Pick<Deposit, 'amountMinor' | 'currency'>,
  ): string | null {
    const reported = parsedPayload as Record<string, unknown>;
    const hasAmount = 'amountMinor' in reported;
    const hasCurrency = 'currency' in reported;
    if (!hasAmount && !hasCurrency) return null;
    if (!hasAmount || !hasCurrency) {
      return 'event reports only one of amount and currency';
    }

    const { amountMinor, currency } = reported;
    if (
      typeof amountMinor !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(amountMinor)
    ) {
      return 'reported amount is not a canonical non-negative integer string';
    }
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      return 'reported currency is not an upper-case 3-letter code';
    }
    if (BigInt(amountMinor) !== deposit.amountMinor) {
      return `reported amount ${amountMinor} differs from the deposit's ${deposit.amountMinor}`;
    }
    if (currency !== deposit.currency) {
      return `reported currency ${currency} differs from the deposit's ${deposit.currency}`;
    }
    return null;
  }

  private asDepositPayload(value: unknown): WebhookDepositPayload | null {
    if (
      value &&
      typeof value === 'object' &&
      'eventType' in value &&
      'providerReference' in value &&
      ((value as WebhookDepositPayload).eventType === 'deposit.completed' ||
        (value as WebhookDepositPayload).eventType === 'deposit.failed' ||
        (value as WebhookDepositPayload).eventType === 'deposit.expired') &&
      typeof (value as WebhookDepositPayload).providerReference === 'string'
    ) {
      return value as WebhookDepositPayload;
    }
    return null;
  }
}
