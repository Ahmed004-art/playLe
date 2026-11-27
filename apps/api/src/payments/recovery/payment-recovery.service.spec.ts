import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEPOSIT_POLL_AFTER_MS,
  PAYOUT_POLL_AFTER_MS,
  PaymentRecoveryService,
} from './payment-recovery.service.js';

function build(providerName = 'MONIME') {
  const prisma = {
    withdrawal: {
      findMany: vi.fn(() => Promise.resolve([{ id: 'w1' }, { id: 'w2' }])),
    },
    deposit: {
      findMany: vi.fn(() => Promise.resolve([{ id: 'd1' }, { id: 'd2' }])),
    },
    paymentReconciliationAnomaly: {
      groupBy: vi.fn(() =>
        Promise.resolve([{ type: 'STUCK_PROCESSING', _count: { type: 2 } }]),
      ),
    },
  };
  const withdrawals = {
    refreshPayoutFromProvider: vi.fn((id: string) =>
      id === 'w1'
        ? Promise.resolve('completed')
        : Promise.reject(new Error('boom')),
    ),
  };
  const deposits = {
    refreshDepositFromProvider: vi.fn((id: string) =>
      Promise.resolve(id === 'd1' ? 'expired' : 'paid-unconfirmed'),
    ),
  };
  const reconciliation = {
    runOnce: vi.fn(() =>
      Promise.resolve({
        generatedAt: new Date(),
        anomalies: [],
        newlyRecorded: 0,
      }),
    ),
  };
  const service = new PaymentRecoveryService(
    prisma as never,
    withdrawals as never,
    deposits as never,
    reconciliation as never,
    { name: providerName } as never,
    {} as never,
  );
  return { prisma, withdrawals, deposits, reconciliation, service };
}

afterEach(() => vi.restoreAllMocks());

describe('PaymentRecoveryService', () => {
  it('does nothing with the manual provider', async () => {
    const h = build('MANUAL');

    expect(await h.service.sweep()).toEqual({ payouts: {}, deposits: {} });
    expect(h.prisma.withdrawal.findMany).not.toHaveBeenCalled();
  });

  it('polls overdue payouts and deposits, isolating failures, and alerts on a paid-but-unconfirmed deposit', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const h = build();
    const now = new Date('2026-11-27T12:00:00Z');

    const result = await h.service.sweep(now);

    expect(result).toEqual({
      payouts: { completed: 1, error: 1 },
      deposits: { expired: 1, 'paid-unconfirmed': 1 },
    });
    expect(h.prisma.withdrawal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'PROCESSING',
          updatedAt: { lt: new Date(now.getTime() - PAYOUT_POLL_AFTER_MS) },
        }),
      }),
    );
    expect(h.prisma.deposit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'PENDING',
          provider: 'MONIME',
          createdAt: { lt: new Date(now.getTime() - DEPOSIT_POLL_AFTER_MS) },
        }),
      }),
    );
    const alerts = error.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.startsWith('PAYMENT ALERT'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('d2');
  });

  it('alerts only when reconciliation records something new', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const h = build();

    expect(await h.service.reconcile()).toBe(0);
    expect(error).not.toHaveBeenCalled();

    h.reconciliation.runOnce.mockResolvedValueOnce({
      generatedAt: new Date(),
      anomalies: [],
      newlyRecorded: 3,
    });
    expect(await h.service.reconcile()).toBe(3);
    expect(String(error.mock.calls[0][0])).toMatch(
      /^PAYMENT ALERT: 3 new .*STUCK_PROCESSING=2/,
    );
  });
});
