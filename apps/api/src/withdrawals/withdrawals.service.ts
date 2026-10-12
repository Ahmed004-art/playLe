import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Withdrawal, type WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import {
  PAYMENT_PROVIDER,
  type InitiatePayoutResult,
  type PaymentProviderPort,
  type WebhookPayoutPayload,
} from '../payments/ports/payment-provider.port.js';
import { parseAmountMinor } from '../common/money.js';
import { FINANCIAL_TRANSACTION_OPTIONS } from '../common/prisma-transaction.constants.js';
import type { CursorPage } from '../common/dto/pagination.dto.js';
import type { AppConfiguration } from '../config/configuration.js';
import { NotificationOutboxService } from '../notification-outbox/notification-outbox.service.js';

@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly walletService: WalletService,
    private readonly configService: ConfigService<AppConfiguration, true>,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderPort,
    private readonly notificationOutbox: NotificationOutboxService,
  ) {}

  async create(
    userId: string,
    amountMinorStr: string,
    destinationDetails: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<Withdrawal> {
    const amountMinor = parseAmountMinor(amountMinorStr);
    const minWithdrawal = this.configService.get(
      'payments.minWithdrawalMinor',
      { infer: true },
    );

    if (amountMinor < minWithdrawal) {
      throw new UnprocessableEntityException(
        `Minimum withdrawal is ${minWithdrawal} minor units`,
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const walletId = await this.walletService.getWalletIdForUser(
          tx,
          userId,
        );

        // Lock the wallet before creating a row that references it — see
        // LedgerService.lockWallet for why the order matters (deadlock
        // avoidance under concurrent withdrawals against the same wallet).
        await this.ledgerService.lockWallet(tx, walletId);

        const withdrawal = await tx.withdrawal.create({
          data: {
            userId,
            walletId,
            amountMinor,
            destinationDetails: destinationDetails as Prisma.InputJsonValue,
            idempotencyKey,
          },
        });

        // Atomically move funds from available to held so they can
        // never be simultaneously withdrawn twice or spent elsewhere.
        await this.ledgerService.applyEntry(tx, walletId, {
          type: 'HOLD',
          availableDeltaMinor: -amountMinor,
          heldDeltaMinor: amountMinor,
          relatedWithdrawalId: withdrawal.id,
        });

        return withdrawal;
      }, FINANCIAL_TRANSACTION_OPTIONS);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.withdrawal.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
        });
        if (existing) return existing;
      }
      throw error;
    }
  }

  async findById(userId: string, id: string): Promise<Withdrawal> {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
    });
    if (!withdrawal || withdrawal.userId !== userId) {
      throw new NotFoundException('Withdrawal not found');
    }
    return withdrawal;
  }

  async findByIdAdmin(id: string): Promise<Withdrawal> {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
    });
    if (!withdrawal) {
      throw new NotFoundException('Withdrawal not found');
    }
    return withdrawal;
  }

  async list(
    userId: string,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<Withdrawal>> {
    return this.listInternal({ userId }, { cursor, limit });
  }

  async listAdmin(params: {
    userId?: string;
    status?: WithdrawalStatus;
    cursor?: string;
    limit: number;
  }): Promise<CursorPage<Withdrawal>> {
    const { cursor, limit, ...where } = params;
    return this.listInternal(where, { cursor, limit });
  }

  private async listInternal(
    where: Prisma.WithdrawalWhereInput,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<Withdrawal>> {
    const withdrawals = await this.prisma.withdrawal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = withdrawals.length > limit;
    const items = hasMore ? withdrawals.slice(0, limit) : withdrawals;

    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /** A user may cancel their own request only while it's still awaiting review. */
  async cancel(userId: string, id: string): Promise<Withdrawal> {
    const withdrawal = await this.findById(userId, id);
    this.assertTransition(withdrawal.status, ['PENDING_REVIEW']);

    return this.prisma.$transaction(async (tx) => {
      await this.ledgerService.applyEntry(tx, withdrawal.walletId, {
        type: 'RELEASE',
        availableDeltaMinor: withdrawal.amountMinor,
        heldDeltaMinor: -withdrawal.amountMinor,
        relatedWithdrawalId: withdrawal.id,
      });

      return tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
    }, FINANCIAL_TRANSACTION_OPTIONS);
  }

  /**
   * Approves the withdrawal, then immediately attempts to submit the
   * real payout (`submitPayout`) — the same "create, then call the
   * provider as a separate, non-transactional step" pattern
   * `DepositsService.create` already uses. If no live provider is
   * configured/enabled, `submitPayout` is a safe no-op and the
   * withdrawal simply stays `APPROVED`, exactly as in Phase 3.
   */
  async approve(
    adminId: string,
    id: string,
    reason: string,
  ): Promise<Withdrawal> {
    const withdrawal = await this.findByIdAdmin(id);
    this.assertTransition(withdrawal.status, ['PENDING_REVIEW']);

    const approved = await this.prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        reviewedByAdminId: adminId,
        reviewedAt: new Date(),
        reviewReason: reason,
      },
    });

    return this.submitPayout(approved.id);
  }

  /**
   * Submits an approved withdrawal to the payout provider.
   * `providerIdempotencyKey` is minted once here and persisted on the
   * `ProviderOperation` row — a retried call (e.g. a later manual
   * re-trigger after a transient failure) must reuse that same
   * operation, never mint a second key for the same withdrawal while one
   * is still unresolved (see ADR-019, "no retry with a new idempotency
   * key after an unknown outcome"). Only ever called from `approve`, or
   * directly by an admin/recovery sweep for a withdrawal already in
   * `APPROVED` with no unresolved `ProviderOperation`.
   */
  async submitPayout(id: string): Promise<Withdrawal> {
    const withdrawal = await this.findByIdAdmin(id);
    if (withdrawal.status !== 'APPROVED') {
      // Not an error — `approve()` always calls this immediately, so a
      // second call (e.g. a recovery sweep racing the original approval)
      // finding the withdrawal already past APPROVED is an expected,
      // safe no-op.
      return withdrawal;
    }

    const providerIdempotencyKey = randomUUID();
    const operation = await this.prisma.providerOperation.create({
      data: {
        provider: this.provider.name,
        kind: 'PAYOUT_SUBMIT',
        relatedWithdrawalId: withdrawal.id,
        providerIdempotencyKey,
        status: 'PENDING',
        requestSnapshot: {
          amountMinor: withdrawal.amountMinor.toString(),
          currency: withdrawal.currency,
        },
      },
    });

    let result: InitiatePayoutResult;
    try {
      result = await this.provider.initiatePayout({
        withdrawalId: withdrawal.id,
        userId: withdrawal.userId,
        amountMinor: withdrawal.amountMinor,
        currency: withdrawal.currency,
        destinationDetails: withdrawal.destinationDetails as Record<
          string,
          unknown
        >,
        providerIdempotencyKey,
      });
    } catch (error) {
      // A network-level failure (e.g. timeout) after the request may
      // already have reached the provider — the outcome is genuinely
      // unknown, not a failure. Never retried with a new key; only
      // resolved via `checkPayoutStatus`/reconciliation.
      this.logger.error(
        `Payout submission for withdrawal ${withdrawal.id} ended in an unknown outcome: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.prisma.providerOperation.update({
        where: { id: operation.id },
        data: {
          status: 'UNKNOWN',
          failureReason:
            error instanceof Error ? error.message : 'Unknown error',
        },
      });
      return this.prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: 'PROCESSING' },
      });
    }

    if (result.outcome === 'UNAVAILABLE') {
      // No live call was made (provider inert/unconfigured) — the
      // existing manual-admin completion flow applies unchanged.
      await this.prisma.providerOperation.update({
        where: { id: operation.id },
        data: {
          status: 'FAILED',
          failureReason: 'Provider unavailable — no live call made',
          resolvedAt: new Date(),
        },
      });
      return withdrawal;
    }

    // A payout outcome is never `EXPIRED` (that's deposit-Payment-Code-
    // only); this narrows `ProviderOperationOutcome` to exactly what
    // Prisma's `ProviderOperationStatus` enum accepts.
    const operationStatus =
      result.outcome === 'EXPIRED' ? 'UNKNOWN' : result.outcome;
    await this.prisma.providerOperation.update({
      where: { id: operation.id },
      data: {
        status: operationStatus,
        responseSnapshot: (result.raw ?? null) as Prisma.InputJsonValue,
        failureReason: result.failureReason,
        resolvedAt: operationStatus === 'PENDING' ? null : new Date(),
      },
    });

    const processing = await this.prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: 'PROCESSING',
        providerReference:
          result.providerReference ?? withdrawal.providerReference,
      },
    });

    await this.notificationOutbox.enqueueStandalone({
      userId: withdrawal.userId,
      type: 'WITHDRAWAL_SUBMITTED',
      payload: {
        withdrawalId: withdrawal.id,
        amountMinor: withdrawal.amountMinor.toString(),
        currency: withdrawal.currency,
      },
    });

    // A provider that answers synchronously with a final outcome is
    // resolved immediately rather than waiting for a webhook that will
    // never arrive.
    if (result.outcome === 'SUCCEEDED') {
      return this.completeFromProviderEvent(
        processing.id,
        result.providerReference ?? undefined,
      );
    }
    if (result.outcome === 'FAILED') {
      return this.failFromProviderEvent(
        processing.id,
        result.failureReason ?? 'Provider rejected the payout',
      );
    }

    // PENDING or UNKNOWN: await a webhook delivery or a later
    // reconciliation/status-check sweep.
    return processing;
  }

  async reject(
    adminId: string,
    id: string,
    reason: string,
  ): Promise<Withdrawal> {
    const withdrawal = await this.findByIdAdmin(id);
    this.assertTransition(withdrawal.status, ['PENDING_REVIEW']);

    return this.prisma.$transaction(async (tx) => {
      await this.ledgerService.applyEntry(tx, withdrawal.walletId, {
        type: 'RELEASE',
        availableDeltaMinor: withdrawal.amountMinor,
        heldDeltaMinor: -withdrawal.amountMinor,
        relatedWithdrawalId: withdrawal.id,
      });

      return tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: 'REJECTED',
          rejectedAt: new Date(),
          reviewedByAdminId: adminId,
          reviewedAt: new Date(),
          reviewReason: reason,
        },
      });
    }, FINANCIAL_TRANSACTION_OPTIONS);
  }

  /**
   * Funds permanently leave the system — the admin confirms the payout
   * was sent. Allowed from `APPROVED` (the pre-Phase-6 manual path, still
   * used whenever no live provider ran) or `PROCESSING` (a live payout
   * the admin is resolving by hand after reconciling with the provider
   * out-of-band — never a "just mark it done" shortcut: `reason` is
   * mandatory and audited exactly as before).
   */
  async complete(
    adminId: string,
    id: string,
    reason: string,
    providerReference?: string,
  ): Promise<Withdrawal> {
    const withdrawal = await this.findByIdAdmin(id);
    this.assertTransition(withdrawal.status, ['APPROVED', 'PROCESSING']);

    return this.prisma.$transaction(async (tx) => {
      await this.ledgerService.applyEntry(tx, withdrawal.walletId, {
        type: 'WITHDRAWAL',
        availableDeltaMinor: 0n,
        heldDeltaMinor: -withdrawal.amountMinor,
        relatedWithdrawalId: withdrawal.id,
        providerReference,
      });

      return tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          reviewedByAdminId: adminId,
          reviewedAt: new Date(),
          reviewReason: reason,
          providerReference,
        },
      });
    }, FINANCIAL_TRANSACTION_OPTIONS);
  }

  /** Mirrors `complete` — allowed from `APPROVED` or `PROCESSING` (see above). */
  async fail(adminId: string, id: string, reason: string): Promise<Withdrawal> {
    const withdrawal = await this.findByIdAdmin(id);
    this.assertTransition(withdrawal.status, ['APPROVED', 'PROCESSING']);

    return this.prisma.$transaction(async (tx) => {
      await this.ledgerService.applyEntry(tx, withdrawal.walletId, {
        type: 'RELEASE',
        availableDeltaMinor: withdrawal.amountMinor,
        heldDeltaMinor: -withdrawal.amountMinor,
        relatedWithdrawalId: withdrawal.id,
      });

      return tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: 'FAILED',
          failedAt: new Date(),
          failureReason: reason,
          reviewedByAdminId: adminId,
          reviewedAt: new Date(),
          reviewReason: reason,
        },
      });
    }, FINANCIAL_TRANSACTION_OPTIONS);
  }

  /**
   * Credits — i.e. finalizes — a withdrawal from a **verified** provider
   * event (a payout webhook) rather than an admin action. Idempotent: a
   * withdrawal no longer in `APPROVED`/`PROCESSING` is returned
   * unchanged, so a duplicate webhook delivery never double-releases the
   * hold. Never callable from client input directly.
   */
  async completeFromProviderEvent(
    withdrawalId: string,
    providerReference: string | undefined,
  ): Promise<Withdrawal> {
    const existing = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
    });
    if (!existing) {
      throw new NotFoundException('Withdrawal not found');
    }
    if (existing.status !== 'APPROVED' && existing.status !== 'PROCESSING') {
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
      await this.ledgerService.applyEntry(tx, existing.walletId, {
        type: 'WITHDRAWAL',
        availableDeltaMinor: 0n,
        heldDeltaMinor: -existing.amountMinor,
        relatedWithdrawalId: existing.id,
        providerReference,
      });

      const updated = await tx.withdrawal.update({
        where: { id: existing.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          providerReference: providerReference ?? existing.providerReference,
        },
      });

      await this.notificationOutbox.enqueue(tx, {
        userId: existing.userId,
        type: 'WITHDRAWAL_COMPLETED',
        payload: {
          withdrawalId: existing.id,
          amountMinor: existing.amountMinor.toString(),
          currency: existing.currency,
        },
      });

      return updated;
    }, FINANCIAL_TRANSACTION_OPTIONS);
  }

  /** The payout-webhook equivalent of `fail` — see `completeFromProviderEvent`. */
  async failFromProviderEvent(
    withdrawalId: string,
    reason: string,
  ): Promise<Withdrawal> {
    const existing = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
    });
    if (!existing) {
      throw new NotFoundException('Withdrawal not found');
    }
    if (existing.status !== 'APPROVED' && existing.status !== 'PROCESSING') {
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
      await this.ledgerService.applyEntry(tx, existing.walletId, {
        type: 'RELEASE',
        availableDeltaMinor: existing.amountMinor,
        heldDeltaMinor: -existing.amountMinor,
        relatedWithdrawalId: existing.id,
      });

      await this.notificationOutbox.enqueue(tx, {
        userId: existing.userId,
        type: 'WITHDRAWAL_FAILED',
        payload: {
          withdrawalId: existing.id,
          amountMinor: existing.amountMinor.toString(),
          currency: existing.currency,
          reason,
        },
      });

      return tx.withdrawal.update({
        where: { id: existing.id },
        data: { status: 'FAILED', failedAt: new Date(), failureReason: reason },
      });
    }, FINANCIAL_TRANSACTION_OPTIONS);
  }

  getProvider(): PaymentProviderPort {
    return this.provider;
  }

  async findByProviderReference(
    providerReference: string,
  ): Promise<Withdrawal | null> {
    return this.prisma.withdrawal.findFirst({ where: { providerReference } });
  }

  /**
   * Entry point for payout webhook deliveries, dispatched by
   * `WebhooksController` for any event that classifies as a payout (as
   * opposed to a deposit — see `DepositsService.processProviderWebhook`,
   * its exact structural twin). Verifies authenticity first (fails
   * closed for an unverified/real Monime signature — see
   * `MonimeProvider`), records every delivery attempt in `ProviderEvent`
   * for idempotency + audit, and only then applies any ledger effect.
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

    const payload = this.asPayoutPayload(verification.parsedPayload);
    const withdrawal = payload
      ? await this.findByProviderReference(payload.providerReference)
      : null;

    if (!payload || !withdrawal) {
      await this.prisma.providerEvent.update({
        where: { id: providerEvent.id },
        data: { status: 'IGNORED', processedAt: new Date() },
      });
      return 'ignored';
    }

    if (payload.eventType === 'payout.completed') {
      await this.completeFromProviderEvent(
        withdrawal.id,
        payload.providerReference,
      );
    } else if (payload.eventType === 'payout.failed') {
      await this.failFromProviderEvent(
        withdrawal.id,
        payload.reason ?? 'Provider reported a failed payout',
      );
    }
    // 'payout.processing' (e.g. Monime's "delayed" event): no ledger
    // effect — the withdrawal is already PROCESSING; recorded below for
    // audit only.

    await this.prisma.providerEvent.update({
      where: { id: providerEvent.id },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
        relatedWithdrawalId: withdrawal.id,
      },
    });

    return 'processed';
  }

  private asPayoutPayload(value: unknown): WebhookPayoutPayload | null {
    if (
      value &&
      typeof value === 'object' &&
      'eventType' in value &&
      'providerReference' in value &&
      ((value as WebhookPayoutPayload).eventType === 'payout.completed' ||
        (value as WebhookPayoutPayload).eventType === 'payout.failed' ||
        (value as WebhookPayoutPayload).eventType === 'payout.processing') &&
      typeof (value as WebhookPayoutPayload).providerReference === 'string'
    ) {
      return value as WebhookPayoutPayload;
    }
    return null;
  }

  private assertTransition(
    current: WithdrawalStatus,
    allowedFrom: WithdrawalStatus[],
  ): void {
    if (!allowedFrom.includes(current)) {
      throw new ConflictException(
        `Cannot perform this action on a withdrawal in status ${current}`,
      );
    }
  }
}
