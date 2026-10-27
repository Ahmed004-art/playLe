import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PaymentAnomalyStatus,
  PaymentAnomalyType,
  PaymentReconciliationAnomaly,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CursorPage } from '../common/dto/pagination.dto.js';
import type { AppConfiguration } from '../config/configuration.js';
import { STUCK_PROCESSING_THRESHOLD_MS } from './reconciliation.constants.js';

export interface DetectedAnomaly {
  type: PaymentAnomalyType;
  relatedDepositId?: string;
  relatedWithdrawalId?: string;
  detail: string;
  /**
   * Identifies one specific provider event, for an anomaly that has no deposit
   * or withdrawal to be keyed on (so different events stay independently
   * tracked). Stored in `details.eventKey` and matched with a JSON path filter
   * when looking for an already-open anomaly.
   */
  eventKey?: string;
}

export interface PaymentReconciliationReport {
  generatedAt: Date;
  /** Every anomaly detected on this run, whether newly persisted or already open. */
  anomalies: DetectedAnomaly[];
  /** How many of the above were newly written to `PaymentReconciliationAnomaly`. */
  newlyRecorded: number;
}

/**
 * On-demand (admin-triggered, never scheduled) anomaly detection for
 * *payment-provider* state — deposits, withdrawals, provider operations
 * and provider events. Distinct from `settlement/reconciliation.service.ts`
 * (Phase 5's match-financial-engine reconciliation, which never touches
 * provider state at all). Every check here is read-only against existing
 * rows; detecting an anomaly only ever *records* a
 * `PaymentReconciliationAnomaly` row for human review — it never mutates
 * money or historical financial records (see ADR-019). Resolving an
 * anomaly happens only through the ordinary Deposit/Withdrawal/Ledger
 * service paths (e.g. `WithdrawalsService.complete`/`fail`), recorded
 * back onto the anomaly row by the admin endpoint for audit.
 */
@Injectable()
export class PaymentReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  async runOnce(): Promise<PaymentReconciliationReport> {
    const anomalies: DetectedAnomaly[] = [
      ...(await this.findDepositCreditedWithoutConfirmation()),
      ...(await this.findDepositConfirmedNotCredited()),
      ...(await this.findRejectedCompletions()),
      ...(await this.findWithdrawalPaidNotCompleted()),
      ...(await this.findWithdrawalCompletedWithoutConfirmation()),
      ...(await this.findDuplicateProviderReferences()),
      ...(await this.findStuckProcessing()),
      ...(await this.findUnknownPayoutOutcomes()),
      ...(await this.findOrphanProviderEvents()),
      ...(await this.findStaleReceivedEvents()),
      ...(await this.findLedgerProviderDrift()),
    ];

    let newlyRecorded = 0;
    for (const anomaly of anomalies) {
      // An anomaly is "already recorded" only while an OPEN one for the same
      // subject exists, so resolving it and still being stale raises a new
      // one. The subject is the related deposit/withdrawal, and - for an
      // anomaly with neither - the specific provider event, so unrelated
      // events are never folded into one another.
      const existing = await this.prisma.paymentReconciliationAnomaly.findFirst(
        {
          where: {
            type: anomaly.type,
            status: 'OPEN',
            relatedDepositId: anomaly.relatedDepositId ?? null,
            relatedWithdrawalId: anomaly.relatedWithdrawalId ?? null,
            ...(anomaly.eventKey
              ? { details: { path: ['eventKey'], equals: anomaly.eventKey } }
              : {}),
          },
        },
      );
      if (!existing) {
        await this.prisma.paymentReconciliationAnomaly.create({
          data: {
            type: anomaly.type,
            relatedDepositId: anomaly.relatedDepositId,
            relatedWithdrawalId: anomaly.relatedWithdrawalId,
            details: {
              detail: anomaly.detail,
              ...(anomaly.eventKey ? { eventKey: anomaly.eventKey } : {}),
            } satisfies Prisma.InputJsonObject,
          },
        });
        newlyRecorded += 1;
      }
    }

    return { generatedAt: new Date(), anomalies, newlyRecorded };
  }

  /**
   * Defense in depth: `DepositsService.completeFromProviderEvent` is the
   * only code path that ever sets `Deposit.status = COMPLETED`, and it's
   * only ever called from the verified-webhook handler — so this should
   * structurally never find anything. Checked anyway, same rationale as
   * Phase 5's `DUPLICATE_SETTLEMENT` check.
   */
  private async findDepositCreditedWithoutConfirmation(): Promise<
    DetectedAnomaly[]
  > {
    const completed = await this.prisma.deposit.findMany({
      where: { status: 'COMPLETED' },
      select: { id: true, providerEvents: { select: { status: true } } },
    });
    return completed
      .filter((d) => !d.providerEvents.some((e) => e.status === 'PROCESSED'))
      .map((d) => ({
        type: 'DEPOSIT_CREDITED_WITHOUT_PROVIDER_CONFIRMATION' as const,
        relatedDepositId: d.id,
        detail: 'Deposit is COMPLETED but has no PROCESSED ProviderEvent',
      }));
  }

  /** A processed deposit-completion event whose deposit never actually moved to COMPLETED. */
  private async findDepositConfirmedNotCredited(): Promise<DetectedAnomaly[]> {
    const events = await this.prisma.providerEvent.findMany({
      where: { status: 'PROCESSED', eventType: { contains: 'completed' } },
      select: {
        id: true,
        relatedDepositId: true,
        deposit: { select: { status: true } },
      },
    });
    return events
      .filter((e) => e.relatedDepositId && e.deposit?.status !== 'COMPLETED')
      .map((e) => ({
        type: 'DEPOSIT_PROVIDER_CONFIRMED_NOT_CREDITED' as const,
        relatedDepositId: e.relatedDepositId ?? undefined,
        detail: `Provider confirmed completion but deposit status is ${e.deposit?.status}`,
      }));
  }

  /**
   * A completion event that `DepositsService.processProviderWebhook` REJECTED
   * because the amount or currency it reported disagreed with the deposit (or
   * was malformed), on a deposit that is still not COMPLETED. The provider may
   * really have taken money while PlayLe credited nothing, so an operator must
   * decide: nothing is credited, failed or refunded automatically. One anomaly
   * per deposit however many such events arrived; once a later valid event
   * completes the deposit it is no longer reported.
   */
  private async findRejectedCompletions(): Promise<DetectedAnomaly[]> {
    const events = await this.prisma.providerEvent.findMany({
      where: {
        status: 'REJECTED',
        eventType: 'deposit.completed',
        relatedDepositId: { not: null },
        deposit: { status: { not: 'COMPLETED' } },
      },
      select: { relatedDepositId: true, providerEventId: true },
    });

    const byDeposit = new Map<string, string[]>();
    for (const e of events) {
      if (!e.relatedDepositId) continue;
      byDeposit.set(e.relatedDepositId, [
        ...(byDeposit.get(e.relatedDepositId) ?? []),
        e.providerEventId,
      ]);
    }
    return [...byDeposit.entries()].map(([relatedDepositId, eventIds]) => ({
      type: 'AMOUNT_MISMATCH' as const,
      relatedDepositId,
      detail: `${eventIds.length} provider completion event(s) rejected for an amount/currency mismatch or malformed amount (${eventIds.join(', ')}); the deposit was left unchanged and nothing was credited`,
    }));
  }

  /** A processed/succeeded payout confirmation whose withdrawal never actually moved to COMPLETED. */
  private async findWithdrawalPaidNotCompleted(): Promise<DetectedAnomaly[]> {
    const events = await this.prisma.providerEvent.findMany({
      where: {
        status: 'PROCESSED',
        eventType: 'payout.completed',
      },
      select: {
        relatedWithdrawalId: true,
        withdrawal: { select: { status: true } },
      },
    });
    const fromEvents = events
      .filter(
        (e) => e.relatedWithdrawalId && e.withdrawal?.status !== 'COMPLETED',
      )
      .map((e) => ({
        type: 'WITHDRAWAL_PROVIDER_PAID_NOT_COMPLETED' as const,
        relatedWithdrawalId: e.relatedWithdrawalId ?? undefined,
        detail: `Provider confirmed payout completion but withdrawal status is ${e.withdrawal?.status}`,
      }));

    const operations = await this.prisma.providerOperation.findMany({
      where: { kind: 'PAYOUT_SUBMIT', status: 'SUCCEEDED' },
      select: {
        relatedWithdrawalId: true,
        withdrawal: { select: { status: true } },
      },
    });
    const fromOperations = operations
      .filter(
        (o) => o.relatedWithdrawalId && o.withdrawal?.status !== 'COMPLETED',
      )
      .map((o) => ({
        type: 'WITHDRAWAL_PROVIDER_PAID_NOT_COMPLETED' as const,
        relatedWithdrawalId: o.relatedWithdrawalId ?? undefined,
        detail: `A SUCCEEDED payout submission exists but withdrawal status is ${o.withdrawal?.status}`,
      }));

    return [...fromEvents, ...fromOperations];
  }

  /** A COMPLETED withdrawal that claims a provider reference with no matching provider confirmation. */
  private async findWithdrawalCompletedWithoutConfirmation(): Promise<
    DetectedAnomaly[]
  > {
    const completed = await this.prisma.withdrawal.findMany({
      where: { status: 'COMPLETED', providerReference: { not: null } },
      select: {
        id: true,
        providerEvents: { select: { status: true, eventType: true } },
        providerOperations: { select: { status: true, kind: true } },
      },
    });
    return completed
      .filter(
        (w) =>
          !w.providerEvents.some(
            (e) =>
              e.status === 'PROCESSED' && e.eventType === 'payout.completed',
          ) &&
          !w.providerOperations.some(
            (o) => o.kind === 'PAYOUT_SUBMIT' && o.status === 'SUCCEEDED',
          ),
      )
      .map((w) => ({
        type: 'WITHDRAWAL_COMPLETED_WITHOUT_PROVIDER_CONFIRMATION' as const,
        relatedWithdrawalId: w.id,
        detail:
          'Withdrawal is COMPLETED with a provider reference but no matching provider confirmation was found — likely an admin manual completion; confirm out-of-band',
      }));
  }

  private async findDuplicateProviderReferences(): Promise<DetectedAnomaly[]> {
    const deposits = await this.prisma.deposit.groupBy({
      by: ['providerReference'],
      where: { providerReference: { not: null } },
      _count: { providerReference: true },
      having: { providerReference: { _count: { gt: 1 } } },
    });
    const withdrawals = await this.prisma.withdrawal.groupBy({
      by: ['providerReference'],
      where: { providerReference: { not: null } },
      _count: { providerReference: true },
      having: { providerReference: { _count: { gt: 1 } } },
    });
    return [
      ...deposits.map((d) => ({
        type: 'DUPLICATE_PROVIDER_REFERENCE' as const,
        detail: `providerReference "${d.providerReference}" is used by ${d._count.providerReference} deposits`,
      })),
      ...withdrawals.map((w) => ({
        type: 'DUPLICATE_PROVIDER_REFERENCE' as const,
        detail: `providerReference "${w.providerReference}" is used by ${w._count.providerReference} withdrawals`,
      })),
    ];
  }

  private async findStuckProcessing(): Promise<DetectedAnomaly[]> {
    const stuck = await this.prisma.withdrawal.findMany({
      where: {
        status: 'PROCESSING',
        updatedAt: { lt: new Date(Date.now() - STUCK_PROCESSING_THRESHOLD_MS) },
      },
      select: { id: true, updatedAt: true },
    });
    return stuck.map((w) => ({
      type: 'STUCK_PROCESSING' as const,
      relatedWithdrawalId: w.id,
      detail: `Withdrawal has been PROCESSING since ${w.updatedAt.toISOString()} with no resolution`,
    }));
  }

  /** The single most safety-critical check per ADR-019: a payout whose real-world outcome is still unknown. */
  private async findUnknownPayoutOutcomes(): Promise<DetectedAnomaly[]> {
    const unknown = await this.prisma.providerOperation.findMany({
      where: { kind: 'PAYOUT_SUBMIT', status: 'UNKNOWN' },
      select: { relatedWithdrawalId: true, createdAt: true },
    });
    return unknown
      .filter((o) => o.relatedWithdrawalId)
      .map((o) => ({
        type: 'UNKNOWN_PAYOUT_OUTCOME' as const,
        relatedWithdrawalId: o.relatedWithdrawalId ?? undefined,
        detail: `Payout submission outcome has been UNKNOWN since ${o.createdAt.toISOString()} — query the provider or reconcile manually, never resubmit with a new idempotency key`,
      }));
  }

  /** A recognized deposit/payout event that could not be matched to any record. */
  private async findOrphanProviderEvents(): Promise<DetectedAnomaly[]> {
    const ignored = await this.prisma.providerEvent.findMany({
      where: {
        status: 'IGNORED',
        relatedDepositId: null,
        relatedWithdrawalId: null,
        OR: [
          { eventType: { startsWith: 'payment_code.' } },
          { eventType: { startsWith: 'payout.' } },
        ],
      },
      select: { id: true, eventType: true, providerEventId: true },
    });
    return ignored.map((e) => ({
      type: 'ORPHAN_PROVIDER_EVENT' as const,
      detail: `Provider event ${e.providerEventId} (${e.eventType}) looked like a deposit/payout event but matched no record`,
    }));
  }

  /**
   * A verified provider event still `RECEIVED` longer than
   * `payments.providerEventStaleAfterMs`: its processing failed part-way (the
   * event is stored before any money moves) and the provider has not
   * redelivered it, or redelivered it with different content, which is never
   * processed. A redelivery of the same content recovers it (see
   * `provider-events.ts`); this only makes the ones that never are visible.
   *
   * Read-only: nothing is reprocessed and no deposit, withdrawal, wallet or
   * ledger row is touched. An event older than the threshold *strictly* (an
   * event exactly that old is not yet reported) is selected; recent events and
   * events in any final status are not. One anomaly per related deposit or
   * withdrawal (found through the stored payload's provider reference, however
   * many events concern it), and one per event when nothing matches, keyed on
   * the event so unrelated events stay independent.
   */
  private async findStaleReceivedEvents(): Promise<DetectedAnomaly[]> {
    const staleAfterMs = this.configService.get(
      'payments.providerEventStaleAfterMs',
      { infer: true },
    );
    const now = Date.now();
    const events = await this.prisma.providerEvent.findMany({
      where: {
        status: 'RECEIVED',
        createdAt: { lt: new Date(now - staleAfterMs) },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        provider: true,
        providerEventId: true,
        eventType: true,
        payload: true,
        createdAt: true,
      },
    });
    if (events.length === 0) return [];

    const referenceOf = (payload: unknown): string | null => {
      const ref =
        payload && typeof payload === 'object'
          ? (payload as { providerReference?: unknown }).providerReference
          : undefined;
      return typeof ref === 'string' && ref.length > 0 ? ref : null;
    };
    const isPayout = (eventType: string) => eventType.startsWith('payout.');

    const references = (payout: boolean) => [
      ...new Set(
        events
          .filter((e) => isPayout(e.eventType) === payout)
          .map((e) => referenceOf(e.payload))
          .filter((r): r is string => r !== null),
      ),
    ];
    const depositRefs = references(false);
    const withdrawalRefs = references(true);
    const deposits = depositRefs.length
      ? await this.prisma.deposit.findMany({
          where: { providerReference: { in: depositRefs } },
          select: { id: true, providerReference: true },
        })
      : [];
    const withdrawals = withdrawalRefs.length
      ? await this.prisma.withdrawal.findMany({
          where: { providerReference: { in: withdrawalRefs } },
          select: { id: true, providerReference: true },
        })
      : [];
    const depositByRef = new Map(deposits.map((d) => [d.providerReference, d]));
    const withdrawalByRef = new Map(
      withdrawals.map((w) => [w.providerReference, w]),
    );

    const describe = (e: (typeof events)[number]): string => {
      const minutes = Math.floor((now - e.createdAt.getTime()) / 60_000);
      return `${e.provider}/${e.providerEventId} (${e.eventType}, received ${minutes} min ago)`;
    };

    const byDeposit = new Map<string, string[]>();
    const byWithdrawal = new Map<string, string[]>();
    const anomalies: DetectedAnomaly[] = [];
    for (const event of events) {
      const ref = referenceOf(event.payload);
      const deposit =
        ref && !isPayout(event.eventType) ? depositByRef.get(ref) : undefined;
      const withdrawal =
        ref && isPayout(event.eventType) ? withdrawalByRef.get(ref) : undefined;

      if (deposit) {
        byDeposit.set(deposit.id, [
          ...(byDeposit.get(deposit.id) ?? []),
          describe(event),
        ]);
      } else if (withdrawal) {
        byWithdrawal.set(withdrawal.id, [
          ...(byWithdrawal.get(withdrawal.id) ?? []),
          describe(event),
        ]);
      } else {
        anomalies.push({
          type: 'STALE_PROVIDER_EVENT',
          eventKey: `${event.provider}/${event.providerEventId}`,
          detail: `Provider event ${describe(event)} is still RECEIVED and matches no deposit or withdrawal; it was not processed. Review it; a redelivery of the same content would recover it, one with different content is never processed.`,
        });
      }
    }

    const detail = (kind: string, described: string[]) =>
      `${described.length} provider event(s) for this ${kind} still RECEIVED, so any money effect may not have been applied: ${described.join('; ')}. Nothing was reprocessed; a redelivery of the same content would recover it, one with different content is never processed. Check the ${kind}'s status and the provider.`;
    for (const [id, described] of byDeposit) {
      anomalies.push({
        type: 'STALE_PROVIDER_EVENT',
        relatedDepositId: id,
        detail: detail('deposit', described),
      });
    }
    for (const [id, described] of byWithdrawal) {
      anomalies.push({
        type: 'STALE_PROVIDER_EVENT',
        relatedWithdrawalId: id,
        detail: detail('withdrawal', described),
      });
    }
    return anomalies;
  }

  /** Per-record check: a terminal deposit/withdrawal's own ledger entries don't sum to its amount. */
  private async findLedgerProviderDrift(): Promise<DetectedAnomaly[]> {
    const anomalies: DetectedAnomaly[] = [];

    const completedDeposits = await this.prisma.deposit.findMany({
      where: { status: 'COMPLETED' },
      select: { id: true, amountMinor: true, ledgerEntries: true },
    });
    for (const d of completedDeposits) {
      const credited = d.ledgerEntries.reduce(
        (sum, e) => sum + e.availableDeltaMinor,
        0n,
      );
      if (credited !== d.amountMinor) {
        anomalies.push({
          type: 'LEDGER_PROVIDER_DRIFT',
          relatedDepositId: d.id,
          detail: `Deposit amount ${d.amountMinor} but related ledger entries credited ${credited}`,
        });
      }
    }

    const completedWithdrawals = await this.prisma.withdrawal.findMany({
      where: { status: 'COMPLETED' },
      select: { id: true, amountMinor: true, ledgerEntries: true },
    });
    for (const w of completedWithdrawals) {
      const availableDelta = w.ledgerEntries.reduce(
        (sum, e) => sum + e.availableDeltaMinor,
        0n,
      );
      const heldDelta = w.ledgerEntries.reduce(
        (sum, e) => sum + e.heldDeltaMinor,
        0n,
      );
      // HOLD: available -amount, held +amount. Completion: available 0,
      // held -amount. Net across both: available -amount, held 0.
      if (availableDelta !== -w.amountMinor || heldDelta !== 0n) {
        anomalies.push({
          type: 'LEDGER_PROVIDER_DRIFT',
          relatedWithdrawalId: w.id,
          detail: `Withdrawal amount ${w.amountMinor} but related ledger entries net available=${availableDelta} held=${heldDelta}`,
        });
      }
    }

    return anomalies;
  }

  async listAnomalies(params: {
    status?: PaymentAnomalyStatus;
    cursor?: string;
    limit: number;
  }): Promise<CursorPage<PaymentReconciliationAnomaly>> {
    const { status, cursor, limit } = params;
    const rows = await this.prisma.paymentReconciliationAnomaly.findMany({
      where: status ? { status } : {},
      orderBy: { detectedAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /**
   * Marks an anomaly resolved — never mutates any money or financial
   * record. The admin is expected to have already fixed the underlying
   * issue (if any) through the ordinary Deposit/Withdrawal/Ledger
   * service paths; this just records that review happened, by whom, and
   * why (same mandatory-reason, audited pattern as every other admin
   * financial action in this codebase).
   */
  async resolveAnomaly(
    adminId: string,
    id: string,
    resolutionNote: string,
  ): Promise<PaymentReconciliationAnomaly> {
    const existing = await this.prisma.paymentReconciliationAnomaly.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('Anomaly not found');
    }
    return this.prisma.paymentReconciliationAnomaly.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        resolvedByAdminId: adminId,
        resolutionNote,
        resolvedAt: new Date(),
      },
    });
  }
}
