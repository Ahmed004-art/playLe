import { describe, expect, it, vi } from 'vitest';
import { PaymentReconciliationService } from './payment-reconciliation.service.js';

/**
 * A completion event that `DepositsService.processProviderWebhook` REJECTED
 * (amount/currency mismatch or malformed) must be discoverable by operators:
 * `findRejectedCompletions` reports it as an AMOUNT_MISMATCH anomaly, once per
 * deposit, for as long as the deposit has not been completed by a later valid
 * event. The database is replaced by a fake; the end-to-end behaviour against
 * Postgres is `test/payments-phase6.e2e-spec.ts` (CI only).
 */

type Rejected = { relatedDepositId: string | null; providerEventId: string };

function build(events: Rejected[]) {
  const prisma = {
    providerEvent: { findMany: vi.fn(() => Promise.resolve(events)) },
  };
  const service = new PaymentReconciliationService(prisma as never);
  const find = () =>
    (
      service as unknown as {
        findRejectedCompletions: () => Promise<
          { type: string; relatedDepositId?: string; detail: string }[]
        >;
      }
    ).findRejectedCompletions();
  return { prisma, find };
}

describe('PaymentReconciliationService.findRejectedCompletions', () => {
  it('queries only REJECTED deposit.completed events on a not-yet-completed deposit', async () => {
    const { prisma, find } = build([]);

    expect(await find()).toEqual([]);

    expect(prisma.providerEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'REJECTED',
          eventType: 'deposit.completed',
          relatedDepositId: { not: null },
          deposit: { status: { not: 'COMPLETED' } },
        },
      }),
    );
  });

  it('reports a rejected completion as an AMOUNT_MISMATCH anomaly for its deposit', async () => {
    const { find } = build([
      { relatedDepositId: 'deposit-1', providerEventId: 'evt-1' },
    ]);

    const anomalies = await find();

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      type: 'AMOUNT_MISMATCH',
      relatedDepositId: 'deposit-1',
    });
    expect(anomalies[0].detail).toContain('evt-1');
    expect(anomalies[0].detail).toContain('nothing was credited');
  });

  it('reports one anomaly per deposit however many events were rejected', async () => {
    const { find } = build([
      { relatedDepositId: 'deposit-1', providerEventId: 'evt-1' },
      { relatedDepositId: 'deposit-1', providerEventId: 'evt-2' },
      { relatedDepositId: 'deposit-2', providerEventId: 'evt-3' },
    ]);

    const anomalies = await find();

    expect(anomalies.map((a) => a.relatedDepositId).sort()).toEqual([
      'deposit-1',
      'deposit-2',
    ]);
    const first = anomalies.find((a) => a.relatedDepositId === 'deposit-1');
    expect(first?.detail).toContain('2 provider completion event(s)');
    expect(first?.detail).toContain('evt-1');
    expect(first?.detail).toContain('evt-2');
  });

  it('skips an event that is not linked to a deposit', async () => {
    const { find } = build([
      { relatedDepositId: null, providerEventId: 'evt-orphan' },
    ]);

    expect(await find()).toEqual([]);
  });
});
