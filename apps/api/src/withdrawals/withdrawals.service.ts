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
import {
  Prisma,
  type ProviderOperation,
  type Withdrawal,
  type WithdrawalStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import {
  PAYMENT_PROVIDER,
  type CheckPayoutStatusResult,
  type InitiatePayoutResult,
  type PaymentProviderPort,
  type WebhookPayoutPayload,
} from '../payments/ports/payment-provider.port.js';
import { parseAmountMinor } from '../common/money.js';
import { FINANCIAL_TRANSACTION_OPTIONS } from '../common/prisma-transaction.constants.js';
import type { CursorPage } from '../common/dto/pagination.dto.js';
import type { AppConfiguration } from '../config/configuration.js';
import { NotificationOutboxService } from '../notification-outbox/notification-outbox.service.js';
import {
  finishProviderEvent,
  recordProviderEvent,
} from '../payments/provider-events.js';
import { NO_PAYOUT_REQUEST_SENT } from '../payments/reconciliation.constants.js';
import { AdminAuditService } from '../audit/admin-audit.service.js';

/**
 * An admin `complete`/`fail` refused because the payout's outcome is not
 * established. Recorded in the admin audit log (see `auditRefusal`).
 */
export class PayoutUnresolvedException extends ConflictException {}

/**
 * What an admin can do about a withdrawal's payout, for the admin list:
 * `NONE` - no request that could have paid was made (manual completion and
 * failure work as before); `CHECK_WITH_PROVIDER` - completion or failure asks
 * the provider and proceeds only on a matching answer; `UNVERIFIABLE` - an
 * attempt is in flight or has no payout reference, so neither is possible.
 */
export type PayoutCheck = 'NONE' | 'CHECK_WITH_PROVIDER' | 'UNVERIFIABLE';

/** The statuses a withdrawal can be finalized (completed or failed) from. */
const FINALIZABLE: WithdrawalStatus[] = ['APPROVED', 'PROCESSING'];

/** The only status a review decision (approve, cancel, reject) can start from. */
const PENDING: WithdrawalStatus[] = ['PENDING_REVIEW'];

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
    private readonly adminAudit: AdminAuditService,
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

  /**
   * A user may cancel their own request only while it's still awaiting review.
   *
   * The status check is a fast path only: approve, cancel and reject each
   * decide from a status read outside any transaction, so the transaction
   * claims the withdrawal conditionally (`PENDING_REVIEW` only) before it
   * releases the hold. If an approval or rejection won meanwhile, this is the
   * usual 409 and nothing is released.
   */
  async cancel(userId: string, id: string): Promise<Withdrawal> {
    const withdrawal = await this.findById(userId, id);
    this.assertTransition(withdrawal.status, PENDING);

    return this.prisma.$transaction(async (tx) => {
      await this.claimOrThrow(tx, withdrawal, PENDING, {
        status: 'CANCELLED',
        cancelledAt: new Date(),
      });

      await this.ledgerService.applyEntry(tx, withdrawal.walletId, {
        type: 'RELEASE',
        availableDeltaMinor: withdrawal.amountMinor,
        heldDeltaMinor: -withdrawal.amountMinor,
        relatedWithdrawalId: withdrawal.id,
      });

      return tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    }, FINANCIAL_TRANSACTION_OPTIONS);
  }

  /**
   * Approves the withdrawal, then immediately attempts to submit the
   * real payout (`submitPayout`) — the same "create, then call the
   * provider as a separate, non-transactional step" pattern
   * `DepositsService.create` already uses. If no live provider is
   * configured/enabled, `submitPayout` is a safe no-op and the
   * withdrawal simply stays `APPROVED`, exactly as in Phase 3.
   *
   * Approval is a single conditional claim (`PENDING_REVIEW` -> `APPROVED`
   * only), committed before any payout is attempted. The status read above it
   * is a fast path: a cancellation or rejection may have won since, and it has
   * released the hold - approving then would pay out money the user already has
   * back. The claim is one statement on the withdrawal row, so it needs no
   * wallet lock (cancel/reject lock the wallet first, then claim the row;
   * nothing here waits for the wallet, so the two cannot deadlock). The
   * provider is only ever called by `submitPayout`, after this has returned.
   */
  async approve(
    adminId: string,
    id: string,
    reason: string,
  ): Promise<Withdrawal> {
    const withdrawal = await this.findByIdAdmin(id);
    this.assertTransition(withdrawal.status, PENDING);

    const { count } = await this.prisma.withdrawal.updateMany({
      where: { id: withdrawal.id, status: { in: PENDING } },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        reviewedByAdminId: adminId,
        reviewedAt: new Date(),
        reviewReason: reason,
      },
    });
    if (count !== 1) {
      const current = await this.findByIdAdmin(withdrawal.id);
      throw new ConflictException(
        `Cannot perform this action on a withdrawal in status ${current.status}`,
      );
    }

    return this.submitPayout(withdrawal.id);
  }

  /**
   * Submits an approved withdrawal to the payout provider.
   * `providerIdempotencyKey` is persisted on the `ProviderOperation` row
   * before the request is sent. A withdrawal with an attempt that may have
   * reached the provider is never submitted again (see ADR-019, "no retry
   * with a new idempotency key after an unknown outcome", and
   * `beginPayoutAttempt`). Only called from `approve`.
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
    const operation = await this.beginPayoutAttempt(
      withdrawal,
      providerIdempotencyKey,
    );
    if (!operation) {
      return this.findByIdAdmin(withdrawal.id);
    }

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
      await this.markProcessing(withdrawal, operation.id);
      return this.findByIdAdmin(withdrawal.id);
    }

    if (result.outcome === 'UNAVAILABLE') {
      // No live call was made (provider inert/unconfigured) — the
      // existing manual-admin completion flow applies unchanged.
      await this.prisma.providerOperation.update({
        where: { id: operation.id },
        data: {
          status: 'FAILED',
          failureReason: NO_PAYOUT_REQUEST_SENT,
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
        responseSnapshot: result.raw ?? undefined,
        failureReason: result.failureReason,
        resolvedAt:
          operationStatus === 'PENDING' || operationStatus === 'UNKNOWN'
            ? null
            : new Date(),
      },
    });

    const submitted = await this.markProcessing(
      withdrawal,
      operation.id,
      result.providerReference ?? withdrawal.providerReference,
    );
    if (!submitted) {
      // Finalised by someone else while the request was in flight (see
      // `markProcessing`): their outcome stands, so neither announce a
      // submission nor act on the provider's answer. The attempt itself is
      // already recorded on the ProviderOperation row.
      return this.findByIdAdmin(withdrawal.id);
    }
    const processing = await this.findByIdAdmin(withdrawal.id);
    if (result.outcome === 'UNKNOWN') {
      // The funds stay held. Nothing is announced: it is not known that a
      // payout exists. Payment reconciliation reports it to an admin.
      this.logger.error(
        `Payout submission for withdrawal ${withdrawal.id} ended in an unknown outcome: ${result.failureReason ?? 'no usable status'}`,
      );
      return processing;
    }

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

    // PENDING: await a webhook delivery, or an admin resolving it.
    return processing;
  }

  /**
   * Records a payout attempt before anything is sent, or returns `null` if one
   * must not be made. Under the wallet lock - the lock every release of this
   * hold takes - the withdrawal must still be `APPROVED` with no attempt that
   * may have reached the provider. So a release and a submission cannot both
   * proceed, and two submissions cannot send requests under two keys.
   */
  private beginPayoutAttempt(
    withdrawal: Pick<
      Withdrawal,
      'id' | 'walletId' | 'amountMinor' | 'currency'
    >,
    providerIdempotencyKey: string,
  ): Promise<ProviderOperation | null> {
    return this.prisma.$transaction(async (tx) => {
      await this.ledgerService.lockWallet(tx, withdrawal.walletId);
      const current = await tx.withdrawal.findUniqueOrThrow({
        where: { id: withdrawal.id },
      });
      if (current.status !== 'APPROVED') return null;
      if ((await this.unresolvedPayouts(tx, withdrawal.id)).length > 0) {
        return null;
      }

      return tx.providerOperation.create({
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
    }, FINANCIAL_TRANSACTION_OPTIONS);
  }

  /**
   * Payout attempts that may have created a payout. An attempt is `FAILED`
   * only when no request was sent, or the provider established that it will
   * not pay.
   */
  private unresolvedPayouts(
    db: Prisma.TransactionClient,
    withdrawalId: string,
  ): Promise<ProviderOperation[]> {
    return db.providerOperation.findMany({
      where: {
        relatedWithdrawalId: withdrawalId,
        kind: 'PAYOUT_SUBMIT',
        status: { not: 'FAILED' },
      },
    });
  }

  /**
   * What the provider says about a withdrawal's one unresolved payout attempt,
   * or `null` when there is none (no request that could have paid was made).
   * A recorded `SUCCEEDED` attempt is used as is. Otherwise the provider is
   * asked about the stored payout reference, and the check is recorded with
   * the admin and reason whatever it answers. Throws when no check is
   * possible: an attempt in flight or without a payout reference (no lookup by
   * our metadata or idempotency key is documented), or more than one attempt.
   * Called outside any transaction; callers re-check under the wallet lock.
   */
  private async payoutEvidence(
    withdrawalId: string,
    adminId: string,
    reason: string,
  ): Promise<{ attemptId: string; outcome: string } | null> {
    const unresolved = await this.unresolvedPayouts(this.prisma, withdrawalId);
    if (unresolved.length === 0) return null;

    const [attempt] = unresolved;
    if (unresolved.length === 1 && attempt.status === 'SUCCEEDED') {
      return { attemptId: attempt.id, outcome: 'SUCCEEDED' };
    }
    // Read after the attempts, so a reference stored meanwhile is seen.
    const { providerReference } = await this.findByIdAdmin(withdrawalId);
    if (
      unresolved.length > 1 ||
      !providerReference ||
      attempt.provider !== this.provider.name
    ) {
      throw new PayoutUnresolvedException(
        'A payout request for this withdrawal is in progress or has an outcome that cannot be checked with the provider. The funds stay held; reconcile with the provider.',
      );
    }

    let check: CheckPayoutStatusResult;
    try {
      check = await this.provider.checkPayoutStatus({
        withdrawalId,
        providerReference,
      });
    } catch (error) {
      check = {
        outcome: 'UNKNOWN',
        failureReason: error instanceof Error ? error.message : 'Unknown error',
      };
    }
    await this.prisma.providerOperation.create({
      data: {
        provider: this.provider.name,
        kind: 'PAYOUT_STATUS_CHECK',
        relatedWithdrawalId: withdrawalId,
        // Unique per row; a status check is a read and sends no key.
        providerIdempotencyKey: randomUUID(),
        status: check.outcome === 'EXPIRED' ? 'UNKNOWN' : check.outcome,
        requestSnapshot: { providerReference, adminId, reason },
        responseSnapshot: check.raw ?? undefined,
        failureReason: check.failureReason,
        resolvedAt: new Date(),
      },
    });
    return { attemptId: attempt.id, outcome: check.outcome };
  }

  /**
   * Gate on an admin releasing a hold: `null` when no payout can exist, or the
   * attempt the provider has just confirmed as failed. Anything else throws.
   */
  private async confirmNoPayoutWillBeMade(
    withdrawalId: string,
    adminId: string,
    reason: string,
  ): Promise<string | null> {
    const evidence = await this.payoutEvidence(withdrawalId, adminId, reason);
    if (!evidence) return null;
    if (evidence.outcome === 'SUCCEEDED') {
      throw new PayoutUnresolvedException(
        'The provider reports this payout completed. The funds cannot be released; complete the withdrawal instead.',
      );
    }
    if (evidence.outcome !== 'FAILED') {
      throw new PayoutUnresolvedException(
        'The provider has not confirmed that this payout failed. The funds stay held.',
      );
    }
    return evidence.attemptId;
  }

  /**
   * Gate on an admin completing a withdrawal (H1): `null` when no payout
   * request that could have paid was made (manual completion), or the attempt
   * the provider confirms as completed. Anything else throws, so an admin can
   * neither debit a user whose payout may still fail nor record a payment that
   * the original request may duplicate.
   */
  private async confirmPayoutWasMade(
    withdrawalId: string,
    adminId: string,
    reason: string,
  ): Promise<string | null> {
    const evidence = await this.payoutEvidence(withdrawalId, adminId, reason);
    if (!evidence) return null;
    if (evidence.outcome === 'FAILED') {
      throw new PayoutUnresolvedException(
        'The provider reports this payout failed. The withdrawal cannot be completed; fail it instead.',
      );
    }
    if (evidence.outcome !== 'SUCCEEDED') {
      throw new PayoutUnresolvedException(
        'The provider has not confirmed that this payout completed. The funds stay held.',
      );
    }
    return evidence.attemptId;
  }

  /**
   * Records a refused admin `complete`/`fail` in the admin audit log. A logging
   * failure never changes the refusal the admin gets.
   */
  private async auditRefusal(
    error: unknown,
    action: 'complete' | 'fail',
    adminId: string,
    withdrawalId: string,
    reason: string,
  ): Promise<void> {
    if (!(error instanceof PayoutUnresolvedException)) return;
    try {
      await this.adminAudit.record('WITHDRAWAL_FINALIZE_REFUSED', {
        adminId,
        detail: `${action} of withdrawal ${withdrawalId} refused: ${error.message} Reason given: ${reason}`,
      });
    } catch (auditError) {
      this.logger.error(
        `Could not audit a refused ${action} of withdrawal ${withdrawalId}: ${String(auditError)}`,
      );
    }
  }

  /** `PayoutCheck` for each finalizable withdrawal in `withdrawals`. */
  async payoutChecksFor(
    withdrawals: Pick<Withdrawal, 'id' | 'status' | 'providerReference'>[],
  ): Promise<Map<string, PayoutCheck>> {
    const open = withdrawals.filter((w) => FINALIZABLE.includes(w.status));
    const checks = new Map<string, PayoutCheck>();
    if (open.length === 0) return checks;
    const attempts = await this.prisma.providerOperation.findMany({
      where: {
        relatedWithdrawalId: { in: open.map((w) => w.id) },
        kind: 'PAYOUT_SUBMIT',
        status: { not: 'FAILED' },
      },
      select: { relatedWithdrawalId: true, status: true, provider: true },
    });
    for (const w of open) {
      const mine = attempts.filter((a) => a.relatedWithdrawalId === w.id);
      if (mine.length === 0) {
        checks.set(w.id, 'NONE');
      } else if (
        mine.length === 1 &&
        (mine[0].status === 'SUCCEEDED' ||
          (w.providerReference && mine[0].provider === this.provider.name))
      ) {
        checks.set(w.id, 'CHECK_WITH_PROVIDER');
      } else {
        checks.set(w.id, 'UNVERIFIABLE');
      }
    }
    return checks;
  }

  /**
   * Moves a withdrawal to `PROCESSING` once its payout request has been sent,
   * but only if it is *still* `APPROVED`. The request is in flight for as long
   * as the provider takes to answer, and the withdrawal stays `APPROVED` and
   * finalisable throughout, so an admin `complete`/`fail` (or any other
   * finaliser) can win before the answer returns. An unconditional write here
   * would then drag a COMPLETED/FAILED withdrawal back to `PROCESSING`, and the
   * next payout event would find it finalisable again and debit or release a
   * hold a second time. A lost claim writes nothing and is logged loudly: the
   * payout may really have been sent, so a person has to reconcile it with the
   * provider (the ProviderOperation row records what was sent and answered).
   * Payout idempotency and the UNKNOWN-outcome record are untouched: they are
   * written on the ProviderOperation before this runs.
   */
  private async markProcessing(
    withdrawal: Pick<Withdrawal, 'id'>,
    operationId: string,
    providerReference?: string | null,
  ): Promise<boolean> {
    const { count } = await this.prisma.withdrawal.updateMany({
      where: { id: withdrawal.id, status: 'APPROVED' },
      data: {
        status: 'PROCESSING',
        ...(providerReference !== undefined ? { providerReference } : {}),
      },
    });
    if (count !== 1) {
      this.logger.error(
        `Withdrawal ${withdrawal.id} was finalised while its payout request (provider operation ${operationId}) was in flight; left unchanged. The provider may have been paid - reconcile with the provider.`,
      );
    }
    return count === 1;
  }

  async reject(
    adminId: string,
    id: string,
    reason: string,
  ): Promise<Withdrawal> {
    const withdrawal = await this.findByIdAdmin(id);
    this.assertTransition(withdrawal.status, PENDING);

    return this.prisma.$transaction(async (tx) => {
      // Same claim as `cancel`: only a still-PENDING_REVIEW withdrawal's hold
      // may be released, and only by the decision that wins it.
      await this.claimOrThrow(tx, withdrawal, PENDING, {
        status: 'REJECTED',
        rejectedAt: new Date(),
        reviewedByAdminId: adminId,
        reviewedAt: new Date(),
        reviewReason: reason,
      });

      await this.ledgerService.applyEntry(tx, withdrawal.walletId, {
        type: 'RELEASE',
        availableDeltaMinor: withdrawal.amountMinor,
        heldDeltaMinor: -withdrawal.amountMinor,
        relatedWithdrawalId: withdrawal.id,
      });

      return tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
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
    try {
      return await this.completeGated(adminId, id, reason, providerReference);
    } catch (error) {
      await this.auditRefusal(error, 'complete', adminId, id, reason);
      throw error;
    }
  }

  private async completeGated(
    adminId: string,
    id: string,
    reason: string,
    providerReference?: string,
  ): Promise<Withdrawal> {
    const withdrawal = await this.findByIdAdmin(id);
    this.assertTransition(withdrawal.status, FINALIZABLE);
    const confirmedAttemptId = await this.confirmPayoutWasMade(
      withdrawal.id,
      adminId,
      reason,
    );

    return this.prisma.$transaction(async (tx) => {
      // A submission may have started since the check above. It records its
      // attempt under this same lock, so it is either visible here or has not
      // begun and will find the withdrawal no longer APPROVED. The confirmed
      // attempt must also still be unresolved: a provider failure recorded
      // meanwhile wins.
      await this.ledgerService.lockWallet(tx, withdrawal.walletId);
      const unresolved = await this.unresolvedPayouts(tx, withdrawal.id);
      if (
        unresolved.some((attempt) => attempt.id !== confirmedAttemptId) ||
        (confirmedAttemptId &&
          !unresolved.some((attempt) => attempt.id === confirmedAttemptId))
      ) {
        throw new PayoutUnresolvedException(
          'The payout state for this withdrawal changed while the completion was being checked. The funds stay held.',
        );
      }

      // The check above ran outside this transaction; a provider event (or a
      // second admin action) may have finalized it since. Only a won claim
      // moves money.
      await this.claimFinalOrThrow(tx, withdrawal, {
        status: 'COMPLETED',
        completedAt: new Date(),
        reviewedByAdminId: adminId,
        reviewedAt: new Date(),
        reviewReason: reason,
        providerReference,
      });
      if (confirmedAttemptId) {
        await tx.providerOperation.update({
          where: { id: confirmedAttemptId },
          data: { status: 'SUCCEEDED', resolvedAt: new Date() },
        });
      }

      await this.ledgerService.applyEntry(tx, withdrawal.walletId, {
        type: 'WITHDRAWAL',
        availableDeltaMinor: 0n,
        heldDeltaMinor: -withdrawal.amountMinor,
        relatedWithdrawalId: withdrawal.id,
        providerReference,
      });

      return tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    }, FINANCIAL_TRANSACTION_OPTIONS);
  }

  /**
   * Releases the hold. Allowed from `APPROVED` or `PROCESSING`, but only when
   * no payout can exist, or the provider has just confirmed this one failed
   * (see `confirmNoPayoutWillBeMade`). An admin's reason alone never releases
   * an unresolved payout.
   */
  async fail(adminId: string, id: string, reason: string): Promise<Withdrawal> {
    try {
      return await this.failGated(adminId, id, reason);
    } catch (error) {
      await this.auditRefusal(error, 'fail', adminId, id, reason);
      throw error;
    }
  }

  private async failGated(
    adminId: string,
    id: string,
    reason: string,
  ): Promise<Withdrawal> {
    const withdrawal = await this.findByIdAdmin(id);
    this.assertTransition(withdrawal.status, FINALIZABLE);
    const confirmedAttemptId = await this.confirmNoPayoutWillBeMade(
      withdrawal.id,
      adminId,
      reason,
    );

    return this.prisma.$transaction(async (tx) => {
      // A submission may have started since the check above. It records its
      // attempt under this same lock, so it is either visible here or has not
      // begun and will find the withdrawal no longer APPROVED.
      await this.ledgerService.lockWallet(tx, withdrawal.walletId);
      const unresolved = await this.unresolvedPayouts(tx, withdrawal.id);
      if (unresolved.some((attempt) => attempt.id !== confirmedAttemptId)) {
        throw new PayoutUnresolvedException(
          'A payout request for this withdrawal has an unresolved outcome. The funds stay held.',
        );
      }

      // Same claim as `complete`: never release a hold for a withdrawal that a
      // concurrent provider event or admin action already finalized.
      await this.claimFinalOrThrow(tx, withdrawal, {
        status: 'FAILED',
        failedAt: new Date(),
        failureReason: reason,
        reviewedByAdminId: adminId,
        reviewedAt: new Date(),
        reviewReason: reason,
      });
      if (confirmedAttemptId) {
        await tx.providerOperation.update({
          where: { id: confirmedAttemptId },
          data: { status: 'FAILED', resolvedAt: new Date() },
        });
      }

      await this.ledgerService.applyEntry(tx, withdrawal.walletId, {
        type: 'RELEASE',
        availableDeltaMinor: withdrawal.amountMinor,
        heldDeltaMinor: -withdrawal.amountMinor,
        relatedWithdrawalId: withdrawal.id,
      });

      return tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    }, FINANCIAL_TRANSACTION_OPTIONS);
  }

  /**
   * Credits — i.e. finalizes — a withdrawal from a **verified** provider
   * event (a payout webhook) rather than an admin action. Idempotent: a
   * withdrawal no longer in `APPROVED`/`PROCESSING` is returned
   * unchanged, so a duplicate webhook delivery never double-releases the
   * hold. Never callable from client input directly.
   *
   * The status check above the transaction is only a fast path: the
   * transaction claims the withdrawal conditionally (`claimFinal`), so of
   * several concurrent terminal outcomes (this, `failFromProviderEvent`, an
   * admin `complete`/`fail`) exactly one writes the ledger and notifies.
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
    if (!FINALIZABLE.includes(existing.status)) {
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
      const claimed = await this.claimFinal(tx, existing, {
        status: 'COMPLETED',
        completedAt: new Date(),
        providerReference: providerReference ?? existing.providerReference,
      });
      if (!claimed) {
        // Lost to a concurrent terminal outcome: no ledger entry, no notice.
        return tx.withdrawal.findUniqueOrThrow({ where: { id: existing.id } });
      }

      await this.ledgerService.applyEntry(tx, existing.walletId, {
        type: 'WITHDRAWAL',
        availableDeltaMinor: 0n,
        heldDeltaMinor: -existing.amountMinor,
        relatedWithdrawalId: existing.id,
        providerReference,
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

      return tx.withdrawal.findUniqueOrThrow({ where: { id: existing.id } });
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
    if (!FINALIZABLE.includes(existing.status)) {
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
      const claimed = await this.claimFinal(tx, existing, {
        status: 'FAILED',
        failedAt: new Date(),
        failureReason: reason,
      });
      if (!claimed) {
        // Lost to a concurrent terminal outcome: no release, no notice.
        return tx.withdrawal.findUniqueOrThrow({ where: { id: existing.id } });
      }

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

      return tx.withdrawal.findUniqueOrThrow({ where: { id: existing.id } });
    }, FINANCIAL_TRANSACTION_OPTIONS);
  }

  /**
   * Claims a withdrawal for a decision inside the caller's transaction: moves
   * it to `data.status` only if it is *still* in one of the `from` statuses,
   * and reports whether this transaction won.
   *
   * Used for every decision made from a status read outside the transaction:
   * the terminal outcomes (`from` = `FINALIZABLE`: provider and admin complete
   * and fail) and the review decisions (`from` = `PENDING`: cancel, reject).
   * The wallet row is locked first, keeping the lock order every other
   * withdrawal transaction uses (wallet, then withdrawal - see
   * `LedgerService.lockWallet`). The conditional update then takes the
   * withdrawal row lock; a concurrent claimer waits for it, and under READ
   * COMMITTED re-evaluates the WHERE after the winner commits and matches no
   * row. Only the winner goes on to write the ledger, all in one transaction,
   * so a later failure rolls the claim back too.
   */
  private async claim(
    tx: Prisma.TransactionClient,
    withdrawal: Pick<Withdrawal, 'id' | 'walletId'>,
    from: WithdrawalStatus[],
    data: Prisma.WithdrawalUncheckedUpdateManyInput,
  ): Promise<boolean> {
    await this.ledgerService.lockWallet(tx, withdrawal.walletId);
    const { count } = await tx.withdrawal.updateMany({
      where: { id: withdrawal.id, status: { in: from } },
      data,
    });
    return count === 1;
  }

  /** `claim` for admin and user actions: a lost claim is the usual 409. */
  private async claimOrThrow(
    tx: Prisma.TransactionClient,
    withdrawal: Pick<Withdrawal, 'id' | 'walletId'>,
    from: WithdrawalStatus[],
    data: Prisma.WithdrawalUncheckedUpdateManyInput,
  ): Promise<void> {
    if (!(await this.claim(tx, withdrawal, from, data))) {
      const current = await tx.withdrawal.findUniqueOrThrow({
        where: { id: withdrawal.id },
      });
      throw new ConflictException(
        `Cannot perform this action on a withdrawal in status ${current.status}`,
      );
    }
  }

  /** `claim` from `APPROVED`/`PROCESSING`: a terminal outcome. */
  private claimFinal(
    tx: Prisma.TransactionClient,
    withdrawal: Pick<Withdrawal, 'id' | 'walletId'>,
    data: Prisma.WithdrawalUncheckedUpdateManyInput,
  ): Promise<boolean> {
    return this.claim(tx, withdrawal, FINALIZABLE, data);
  }

  private claimFinalOrThrow(
    tx: Prisma.TransactionClient,
    withdrawal: Pick<Withdrawal, 'id' | 'walletId'>,
    data: Prisma.WithdrawalUncheckedUpdateManyInput,
  ): Promise<void> {
    return this.claimOrThrow(tx, withdrawal, FINALIZABLE, data);
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

    // A finished duplicate is ignored; an unfinished (RECEIVED) one is
    // processed again - safe because both finalizers below are conditional
    // claims (see `recordProviderEvent`).
    const providerEvent = await recordProviderEvent(
      this.prisma,
      this.logger,
      this.provider.name,
      verification.providerEventId,
      verification.eventType ?? 'unknown',
      verification.parsedPayload ?? {},
    );
    if (!providerEvent) {
      return 'ignored';
    }

    const payload = this.asPayoutPayload(verification.parsedPayload);
    const withdrawal = payload
      ? await this.findByProviderReference(payload.providerReference)
      : null;

    if (!payload || !withdrawal) {
      await finishProviderEvent(this.prisma, providerEvent.id, {
        status: 'IGNORED',
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

    await finishProviderEvent(this.prisma, providerEvent.id, {
      status: 'PROCESSED',
      relatedWithdrawalId: withdrawal.id,
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
