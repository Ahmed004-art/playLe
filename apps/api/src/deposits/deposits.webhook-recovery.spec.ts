import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { DepositsService } from './deposits.service.js';

/**
 * Recovering a deposit webhook whose first attempt failed part-way (Phase 13).
 *
 * The database is an in-memory model with the properties the code relies on:
 * the unique `(provider, providerEventId)` index (P2002 on a second create), a
 * transaction that rolls back every write when its callback throws, and an
 * atomic conditional claim (`updateMany ... WHERE status = 'PENDING'`). The real
 * behaviour against Postgres is `test/payments-phase6.e2e-spec.ts` (CI only).
 */

interface EventRow {
  id: string;
  status: string;
  eventType: string;
  payload: unknown;
  relatedDepositId?: string;
}

function build() {
  const db = {
    deposit: {
      id: 'deposit-1',
      userId: 'user-1',
      amountMinor: 4000n,
      currency: 'SLE',
      status: 'PENDING',
      providerReference: 'pmc-1',
    },
    events: new Map<string, EventRow>(),
    balance: 0n,
    notifications: 0,
  };

  const tx = {
    deposit: {
      updateMany: vi.fn(
        (args: { where: { status: string }; data: { status: string } }) => {
          if (db.deposit.status !== args.where.status) {
            return Promise.resolve({ count: 0 });
          }
          db.deposit.status = args.data.status;
          return Promise.resolve({ count: 1 });
        },
      ),
      findUniqueOrThrow: vi.fn(() => Promise.resolve({ ...db.deposit })),
    },
  };

  const prisma = {
    providerEvent: {
      create: vi.fn(
        (args: {
          data: {
            providerEventId: string;
            eventType: string;
            payload: unknown;
          };
        }) => {
          if (db.events.has(args.data.providerEventId)) {
            return Promise.reject(
              new Prisma.PrismaClientKnownRequestError('Unique constraint', {
                code: 'P2002',
                clientVersion: 'test',
              }),
            );
          }
          const row: EventRow = {
            id: `pe-${db.events.size + 1}`,
            status: 'RECEIVED',
            eventType: args.data.eventType,
            payload: JSON.parse(JSON.stringify(args.data.payload)) as unknown,
          };
          db.events.set(args.data.providerEventId, row);
          return Promise.resolve({ ...row });
        },
      ),
      findUnique: vi.fn(
        (args: {
          where: { provider_providerEventId: { providerEventId: string } };
        }) => {
          const row = db.events.get(
            args.where.provider_providerEventId.providerEventId,
          );
          return Promise.resolve(row ? { ...row } : null);
        },
      ),
      updateMany: vi.fn(
        (args: {
          where: { id: string; status: string };
          data: { status: string; relatedDepositId?: string };
        }) => {
          const row = [...db.events.values()].find(
            (e) => e.id === args.where.id && e.status === args.where.status,
          );
          if (row) {
            row.status = args.data.status;
            row.relatedDepositId = args.data.relatedDepositId;
          }
          return Promise.resolve({ count: row ? 1 : 0 });
        },
      ),
    },
    deposit: {
      findFirst: vi.fn(() => Promise.resolve({ ...db.deposit })),
      findUnique: vi.fn(() => Promise.resolve({ ...db.deposit })),
    },
    // Rolls back on throw, as a real transaction does.
    $transaction: vi.fn(async (fn: (c: typeof tx) => Promise<unknown>) => {
      const before = {
        status: db.deposit.status,
        balance: db.balance,
        notifications: db.notifications,
      };
      try {
        return await fn(tx);
      } catch (error) {
        db.deposit.status = before.status;
        db.balance = before.balance;
        db.notifications = before.notifications;
        throw error;
      }
    }),
  };

  const ledgerService = {
    applyEntry: vi.fn(
      (_tx: unknown, _wallet: string, p: { availableDeltaMinor: bigint }) => {
        db.balance += p.availableDeltaMinor;
        return Promise.resolve({});
      },
    ),
  };
  const notificationOutbox = {
    enqueue: vi.fn(() => {
      db.notifications += 1;
      return Promise.resolve();
    }),
  };
  const provider = {
    name: 'FAKE',
    verifyWebhookSignature: vi.fn(() => ({
      valid: true,
      providerEventId: 'evt-1',
      eventType: 'deposit.completed',
      parsedPayload: {
        eventType: 'deposit.completed',
        providerReference: 'pmc-1',
        amountMinor: '4000',
        currency: 'SLE',
      },
    })),
  };
  const service = new DepositsService(
    prisma as never,
    ledgerService as never,
    { getWalletIdForUser: vi.fn(() => Promise.resolve('wallet-1')) } as never,
    {} as never,
    provider as never,
    {} as never,
    notificationOutbox as never,
  );
  const deliver = () => service.processProviderWebhook('{}', {});
  return {
    db,
    prisma,
    tx,
    ledgerService,
    notificationOutbox,
    provider,
    deliver,
  };
}

describe('processProviderWebhook - recovering an unfinished deposit event', () => {
  it('a transient failure in the credit, then a redelivery: credited exactly once, event PROCESSED', async () => {
    const h = build();
    h.ledgerService.applyEntry.mockRejectedValueOnce(new Error('deadlock'));

    // First attempt: the money transaction fails and rolls back. The error
    // reaches the controller, so the provider gets a 500 and retries.
    await expect(h.deliver()).rejects.toThrow('deadlock');
    expect(h.db.deposit.status).toBe('PENDING');
    expect(h.db.balance).toBe(0n);
    expect(h.db.events.get('evt-1')?.status).toBe('RECEIVED');

    // Before Phase 13 this redelivery hit the unique index and was ignored,
    // leaving the paid deposit PENDING forever.
    expect(await h.deliver()).toBe('processed');

    expect(h.db.deposit.status).toBe('COMPLETED');
    expect(h.db.balance).toBe(4000n);
    expect(h.db.notifications).toBe(1);
    expect(h.db.events.get('evt-1')).toMatchObject({
      status: 'PROCESSED',
      relatedDepositId: 'deposit-1',
    });
    expect(h.prisma.providerEvent.create).toHaveBeenCalledTimes(2);
  });

  it('a failure after the credit committed: the redelivery finishes the event without crediting again', async () => {
    const h = build();
    // The money transaction commits; marking the event PROCESSED then fails.
    h.prisma.providerEvent.updateMany.mockRejectedValueOnce(
      new Error('connection reset'),
    );

    await expect(h.deliver()).rejects.toThrow('connection reset');
    expect(h.db.balance).toBe(4000n);
    expect(h.db.events.get('evt-1')?.status).toBe('RECEIVED');

    expect(await h.deliver()).toBe('processed');

    expect(h.db.balance).toBe(4000n);
    expect(h.ledgerService.applyEntry).toHaveBeenCalledTimes(1);
    expect(h.db.notifications).toBe(1);
    expect(h.db.events.get('evt-1')?.status).toBe('PROCESSED');
  });

  it('a finished event is still ignored on redelivery: no transaction, no credit', async () => {
    const h = build();
    expect(await h.deliver()).toBe('processed');
    h.prisma.$transaction.mockClear();

    expect(await h.deliver()).toBe('ignored');
    expect(await h.deliver()).toBe('ignored');

    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.db.balance).toBe(4000n);
    expect(h.ledgerService.applyEntry).toHaveBeenCalledTimes(1);
    expect(h.db.notifications).toBe(1);
  });

  it('a redelivery carrying different content under the same event id is never acted on', async () => {
    const h = build();
    h.ledgerService.applyEntry.mockRejectedValueOnce(new Error('deadlock'));
    await expect(h.deliver()).rejects.toThrow('deadlock');

    h.provider.verifyWebhookSignature.mockReturnValueOnce({
      valid: true,
      providerEventId: 'evt-1',
      eventType: 'deposit.completed',
      parsedPayload: {
        eventType: 'deposit.completed',
        providerReference: 'pmc-1',
        amountMinor: '999999',
        currency: 'SLE',
      },
    });

    expect(await h.deliver()).toBe('ignored');
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.db.balance).toBe(0n);
    expect(h.db.events.get('evt-1')?.status).toBe('RECEIVED');
  });

  it('concurrent redeliveries of an unfinished event credit exactly once', async () => {
    const h = build();
    h.ledgerService.applyEntry.mockRejectedValueOnce(new Error('deadlock'));
    await expect(h.deliver()).rejects.toThrow('deadlock');

    const results = await Promise.all([h.deliver(), h.deliver(), h.deliver()]);

    expect(results).toEqual(['processed', 'processed', 'processed']);
    expect(h.db.balance).toBe(4000n);
    expect(h.db.notifications).toBe(1);
    expect(h.db.events.get('evt-1')?.status).toBe('PROCESSED');
  });

  it('a first delivery racing its own redelivery credits exactly once', async () => {
    const h = build();

    const results = await Promise.all([h.deliver(), h.deliver()]);

    // Whichever ran second either recovered the unfinished event (and lost the
    // claim) or found it already finished - never a second credit.
    expect(results).toContain('processed');
    expect(h.db.balance).toBe(4000n);
    expect(h.db.notifications).toBe(1);
  });
});
