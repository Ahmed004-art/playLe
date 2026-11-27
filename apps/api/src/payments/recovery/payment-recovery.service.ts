import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../../config/configuration.js';
import { DepositsService } from '../../deposits/deposits.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { WithdrawalsService } from '../../withdrawals/withdrawals.service.js';
import { PaymentReconciliationService } from '../payment-reconciliation.service.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProviderPort,
} from '../ports/payment-provider.port.js';

/** A PROCESSING payout is polled once it has been waiting this long. */
export const PAYOUT_POLL_AFTER_MS = 2 * 60 * 1000;
/** A PENDING deposit is polled once it has been waiting this long. */
export const DEPOSIT_POLL_AFTER_MS = 10 * 60 * 1000;
/** At most this many withdrawals and this many deposits per sweep. */
export const RECOVERY_BATCH_SIZE = 50;

export interface RecoverySweepResult {
  payouts: Record<string, number>;
  deposits: Record<string, number>;
}

/**
 * Payment recovery: polls the provider for payouts and deposits whose webhook
 * may never come, and runs payment reconciliation on a schedule, raising an
 * alert (an `ERROR` log line starting "PAYMENT ALERT") for anything that needs
 * a person. Plain `setInterval` timers, the pattern `MatchTimeoutService` and
 * `NotificationDispatcherService` use. Every money effect goes through the
 * existing conditional claims (`WithdrawalsService`/`DepositsService`), so a
 * poll racing a webhook or an admin applies at most one outcome. Inert with
 * the manual provider, which has nothing to poll.
 */
@Injectable()
export class PaymentRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentRecoveryService.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly withdrawals: WithdrawalsService,
    private readonly deposits: DepositsService,
    private readonly reconciliation: PaymentReconciliationService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderPort,
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  onModuleInit(): void {
    const payments = this.configService.get('payments', { infer: true });
    this.timers = [
      setInterval(() => {
        this.sweep().catch((error: unknown) =>
          this.logger.error(`Payment recovery sweep failed: ${String(error)}`),
        );
      }, payments.recoverySweepIntervalMs),
      setInterval(() => {
        this.reconcile().catch((error: unknown) =>
          this.logger.error(
            `Scheduled payment reconciliation failed: ${String(error)}`,
          ),
        );
      }, payments.reconciliationIntervalMs),
    ];
  }

  onModuleDestroy(): void {
    this.timers.forEach((timer) => clearInterval(timer));
  }

  async sweep(now = new Date()): Promise<RecoverySweepResult> {
    const result: RecoverySweepResult = { payouts: {}, deposits: {} };
    if (this.provider.name === 'MANUAL') return result;
    const count = (bucket: Record<string, number>, key: string) =>
      (bucket[key] = (bucket[key] ?? 0) + 1);

    const processing = await this.prisma.withdrawal.findMany({
      where: {
        status: 'PROCESSING',
        providerReference: { not: null },
        updatedAt: { lt: new Date(now.getTime() - PAYOUT_POLL_AFTER_MS) },
      },
      orderBy: { updatedAt: 'asc' },
      take: RECOVERY_BATCH_SIZE,
      select: { id: true },
    });
    for (const { id } of processing) {
      try {
        count(
          result.payouts,
          await this.withdrawals.refreshPayoutFromProvider(id),
        );
      } catch (error) {
        count(result.payouts, 'error');
        this.logger.error(`Payout recovery for ${id} failed: ${String(error)}`);
      }
    }

    const pending = await this.prisma.deposit.findMany({
      where: {
        status: 'PENDING',
        provider: this.provider.name,
        providerReference: { not: null },
        createdAt: { lt: new Date(now.getTime() - DEPOSIT_POLL_AFTER_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: RECOVERY_BATCH_SIZE,
      select: { id: true },
    });
    for (const { id } of pending) {
      try {
        const outcome = await this.deposits.refreshDepositFromProvider(id);
        count(result.deposits, outcome);
        if (outcome === 'paid-unconfirmed') {
          this.logger.error(
            `PAYMENT ALERT: the provider reports deposit ${id} paid, but no verified completion with a paid amount has been received. Nothing was credited; reconcile with the provider.`,
          );
        }
      } catch (error) {
        count(result.deposits, 'error');
        this.logger.error(
          `Deposit recovery for ${id} failed: ${String(error)}`,
        );
      }
    }

    if (processing.length > 0 || pending.length > 0) {
      this.logger.log(
        `Payment recovery: payouts ${JSON.stringify(result.payouts)}, deposits ${JSON.stringify(result.deposits)}`,
      );
    }
    return result;
  }

  /** Runs payment reconciliation and alerts on every newly recorded anomaly. */
  async reconcile(): Promise<number> {
    const report = await this.reconciliation.runOnce();
    if (report.newlyRecorded > 0) {
      const open = await this.prisma.paymentReconciliationAnomaly.groupBy({
        by: ['type'],
        where: { status: 'OPEN' },
        _count: { type: true },
      });
      this.logger.error(
        `PAYMENT ALERT: ${report.newlyRecorded} new payment anomaly(ies). Open by type: ${open
          .map((g) => `${g.type}=${g._count.type}`)
          .join(', ')}. Review them in the admin Payments page.`,
      );
    }
    return report.newlyRecorded;
  }
}
