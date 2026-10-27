import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { WithdrawalsService } from './withdrawals.service.js';

/**
 * Terminal withdrawal outcomes (Phase 13): of any number of concurrent
 * completions/failures - payout webhooks, a synchronous provider answer, admin
 * actions - exactly one may apply a ledger effect and notify. Also covers
 * recovering a payout webhook whose first attempt failed part-way.
 *
 * The database is an in-memory model: transactions roll back on throw, the
 * conditional claim (`updateMany ... WHERE status IN (APPROVED, PROCESSING)`) is
 * atomic, and the ledger refuses a negative balance, as `LedgerService` and the
 * CHECK constraints do. Every caller first reads the withdrawal outside its
 * transaction, as the service does, so concurrent callers all see PROCESSING -
 * the race the claim closes. The real behaviour against Postgres is
 * `test/payments-phase6.e2e-spec.ts` (CI only).
 */

interface EventRow {
  id: string;
  status: string;
  eventType: string;
  payload: unknown;
}

function build(initial: { held?: bigint } = {}) {
  const db = {
    withdrawal: {
      id: 'wd-1',
      userId: 'user-1',
      walletId: 'wallet-1',
      amountMinor: 5000n,
      currency: 'SLE',
      status: 'PROCESSING',
      providerReference: 'po-1',
    },
    available: 0n,
    held: initial.held ?? 5000n,
    entries: [] as string[],
    notifications: [] as string[],
    events: new Map<string, EventRow>(),
  };

  // Each transaction keeps an undo log, so a rollback undoes only its own
  // writes - never another transaction's committed ones.
  type Undo = Array<() => void>;
  const journals = new WeakMap<object, Undo>();
  const undoFor = (txClient: unknown): Undo =>
    journals.get(txClient as object) ?? [];

  const tx = {
    withdrawal: {
      updateMany: vi.fn(
        (
          args: {
            where: { status: { in: string[] } };
            data: { status: string };
          },
          undo: Undo = [],
        ) => {
          if (!args.where.status.in.includes(db.withdrawal.status)) {
            return Promise.resolve({ count: 0 });
          }
          const previous = db.withdrawal.status;
          db.withdrawal.status = args.data.status;
          undo.push(() => (db.withdrawal.status = previous));
          return Promise.resolve({ count: 1 });
        },
      ),
      findUniqueOrThrow: vi.fn(() => Promise.resolve({ ...db.withdrawal })),
    },
  };

  const prisma = {
    withdrawal: {
      findUnique: vi.fn(() => Promise.resolve({ ...db.withdrawal })),
      findFirst: vi.fn(() => Promise.resolve({ ...db.withdrawal })),
    },
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
          const row = {
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
          data: { status: string };
        }) => {
          const row = [...db.events.values()].find(
            (e) => e.id === args.where.id && e.status === args.where.status,
          );
          if (row) row.status = args.data.status;
          return Promise.resolve({ count: row ? 1 : 0 });
        },
      ),
    },
    $transaction: vi.fn(async (fn: (c: typeof tx) => Promise<unknown>) => {
      const undo: Undo = [];
      const own = {
        withdrawal: {
          updateMany: (args: Parameters<typeof tx.withdrawal.updateMany>[0]) =>
            tx.withdrawal.updateMany(args, undo),
          findUniqueOrThrow: tx.withdrawal.findUniqueOrThrow,
        },
      };
      journals.set(own, undo);
      try {
        return await fn(own as unknown as typeof tx);
      } catch (error) {
        undo.reverse().forEach((step) => step());
        throw error;
      }
    }),
  };

  const ledgerService = {
    // Yields, so concurrent transactions interleave before claiming.
    lockWallet: vi.fn(async () => {
      await Promise.resolve();
      return {};
    }),
    applyEntry: vi.fn(
      (
        txClient: unknown,
        _walletId: string,
        p: {
          type: string;
          availableDeltaMinor: bigint;
          heldDeltaMinor: bigint;
        },
      ) => {
        const available = db.available + p.availableDeltaMinor;
        const held = db.held + p.heldDeltaMinor;
        if (available < 0n || held < 0n) {
          return Promise.reject(new Error('Insufficient balance'));
        }
        const before = { available: db.available, held: db.held };
        db.available = available;
        db.held = held;
        db.entries.push(p.type);
        undoFor(txClient).push(() => {
          db.available = before.available;
          db.held = before.held;
          db.entries.splice(db.entries.lastIndexOf(p.type), 1);
        });
        return Promise.resolve({});
      },
    ),
  };
  const notificationOutbox = {
    enqueue: vi.fn((txClient: unknown, n: { type: string }) => {
      db.notifications.push(n.type);
      undoFor(txClient).push(() =>
        db.notifications.splice(db.notifications.lastIndexOf(n.type), 1),
      );
      return Promise.resolve();
    }),
  };
  const provider = {
    name: 'FAKE',
    verifyWebhookSignature: vi.fn(() => ({
      valid: true,
      providerEventId: 'evt-po-1',
      eventType: 'payout.completed',
      parsedPayload: {
        eventType: 'payout.completed',
        providerReference: 'po-1',
      },
    })),
  };
  const service = new WithdrawalsService(
    prisma as never,
    ledgerService as never,
    {} as never,
    {} as never,
    provider as never,
    notificationOutbox as never,
  );
  return {
    db,
    prisma,
    tx,
    ledgerService,
    notificationOutbox,
    provider,
    service,
  };
}

describe('withdrawal terminal outcomes are claimed exactly once', () => {
  it('provider completion: claims, then debits the hold and notifies once', async () => {
    const h = build();

    const result = await h.service.completeFromProviderEvent('wd-1', 'po-1');

    expect(result.status).toBe('COMPLETED');
    expect(h.db.entries).toEqual(['WITHDRAWAL']);
    expect(h.db.held).toBe(0n);
    expect(h.db.notifications).toEqual(['WITHDRAWAL_COMPLETED']);
    // The wallet is locked before the withdrawal row is claimed (the lock
    // order every withdrawal transaction uses).
    expect(h.ledgerService.lockWallet.mock.invocationCallOrder[0]).toBeLessThan(
      h.tx.withdrawal.updateMany.mock.invocationCallOrder[0],
    );
  });

  it('concurrent provider completion and failure: exactly one outcome moves money', async () => {
    const h = build();

    const [completed, failed] = await Promise.all([
      h.service.completeFromProviderEvent('wd-1', 'po-1'),
      h.service.failFromProviderEvent('wd-1', 'payout bounced'),
    ]);

    // The first claim won; the loser wrote nothing and returned the row as
    // the winner left it.
    expect(completed.status).toBe('COMPLETED');
    expect(failed.status).toBe('COMPLETED');
    expect(h.db.entries).toEqual(['WITHDRAWAL']);
    expect(h.db.notifications).toEqual(['WITHDRAWAL_COMPLETED']);
    // The hold was not also released back to the user.
    expect(h.db.available).toBe(0n);
    expect(h.db.held).toBe(0n);
  });

  it('concurrent duplicate completions debit the hold once, even when another hold would cover a second debit', async () => {
    // A second pending withdrawal's hold on the same wallet: without the claim
    // the non-negative check alone would let a second debit through.
    const h = build({ held: 10_000n });

    await Promise.all([
      h.service.completeFromProviderEvent('wd-1', 'po-1'),
      h.service.completeFromProviderEvent('wd-1', 'po-1'),
    ]);

    expect(h.db.entries).toEqual(['WITHDRAWAL']);
    expect(h.db.held).toBe(5000n);
    expect(h.db.notifications).toHaveLength(1);
  });

  it('a lost claim writes no ledger entry and sends no notification', async () => {
    const h = build();
    h.tx.withdrawal.updateMany.mockResolvedValueOnce({ count: 0 });

    await h.service.failFromProviderEvent('wd-1', 'payout bounced');

    expect(h.ledgerService.applyEntry).not.toHaveBeenCalled();
    expect(h.notificationOutbox.enqueue).not.toHaveBeenCalled();
  });

  it('an admin failure racing a provider completion is refused (409) and releases nothing', async () => {
    const h = build();

    const [provider, admin] = await Promise.allSettled([
      h.service.completeFromProviderEvent('wd-1', 'po-1'),
      h.service.fail('admin-1', 'wd-1', 'manual fail'),
    ]);

    expect(provider.status).toBe('fulfilled');
    expect(admin.status).toBe('rejected');
    expect((admin as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    );
    expect(h.db.entries).toEqual(['WITHDRAWAL']);
    expect(h.db.available).toBe(0n);
  });

  it('an admin completion racing a provider failure is refused (409) and debits nothing', async () => {
    const h = build();

    const [provider, admin] = await Promise.allSettled([
      h.service.failFromProviderEvent('wd-1', 'payout bounced'),
      h.service.complete('admin-1', 'wd-1', 'manual complete'),
    ]);

    expect(provider.status).toBe('fulfilled');
    expect((admin as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    );
    expect(h.db.entries).toEqual(['RELEASE']);
    expect(h.db.available).toBe(5000n);
    expect(h.db.held).toBe(0n);
  });

  it('a ledger failure rolls the claim back, so a retry can still finalize', async () => {
    const h = build();
    h.ledgerService.applyEntry.mockRejectedValueOnce(new Error('deadlock'));

    await expect(
      h.service.completeFromProviderEvent('wd-1', 'po-1'),
    ).rejects.toThrow('deadlock');
    expect(h.db.withdrawal.status).toBe('PROCESSING');

    await h.service.completeFromProviderEvent('wd-1', 'po-1');
    expect(h.db.entries).toEqual(['WITHDRAWAL']);
  });
});

describe('processProviderWebhook - recovering an unfinished payout event', () => {
  const deliver = (h: ReturnType<typeof build>) =>
    h.service.processProviderWebhook('{}', {});

  it('a transient failure, then a redelivery: finalized once, event PROCESSED', async () => {
    const h = build();
    h.ledgerService.applyEntry.mockRejectedValueOnce(new Error('deadlock'));

    await expect(deliver(h)).rejects.toThrow('deadlock');
    expect(h.db.events.get('evt-po-1')?.status).toBe('RECEIVED');
    expect(h.db.withdrawal.status).toBe('PROCESSING');

    expect(await deliver(h)).toBe('processed');
    expect(h.db.entries).toEqual(['WITHDRAWAL']);
    expect(h.db.notifications).toEqual(['WITHDRAWAL_COMPLETED']);
    expect(h.db.events.get('evt-po-1')?.status).toBe('PROCESSED');
  });

  it('a failure after the money committed: the redelivery finishes the event without debiting again', async () => {
    const h = build();
    h.prisma.providerEvent.updateMany.mockRejectedValueOnce(
      new Error('connection reset'),
    );

    await expect(deliver(h)).rejects.toThrow('connection reset');
    expect(h.db.entries).toEqual(['WITHDRAWAL']);

    expect(await deliver(h)).toBe('processed');
    expect(h.db.entries).toEqual(['WITHDRAWAL']);
    expect(h.db.events.get('evt-po-1')?.status).toBe('PROCESSED');
  });

  it('concurrent redeliveries of an unfinished payout event finalize once', async () => {
    const h = build();
    h.ledgerService.applyEntry.mockRejectedValueOnce(new Error('deadlock'));
    await expect(deliver(h)).rejects.toThrow('deadlock');

    await Promise.all([deliver(h), deliver(h), deliver(h)]);

    expect(h.db.entries).toEqual(['WITHDRAWAL']);
    expect(h.db.notifications).toHaveLength(1);
  });

  it('a finished payout event is still ignored on redelivery', async () => {
    const h = build();
    expect(await deliver(h)).toBe('processed');
    h.prisma.$transaction.mockClear();

    expect(await deliver(h)).toBe('ignored');
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.db.entries).toEqual(['WITHDRAWAL']);
  });

  it('competing completed and failed events (different ids) apply one outcome', async () => {
    const h = build();
    h.provider.verifyWebhookSignature
      .mockReturnValueOnce({
        valid: true,
        providerEventId: 'evt-a',
        eventType: 'payout.completed',
        parsedPayload: {
          eventType: 'payout.completed',
          providerReference: 'po-1',
        },
      })
      .mockReturnValueOnce({
        valid: true,
        providerEventId: 'evt-b',
        eventType: 'payout.failed',
        parsedPayload: {
          eventType: 'payout.failed',
          providerReference: 'po-1',
        },
      });

    await Promise.all([deliver(h), deliver(h)]);

    expect(h.db.entries).toHaveLength(1);
    expect(h.db.notifications).toHaveLength(1);
    expect(h.db.available + h.db.held).toBe(
      h.db.entries[0] === 'RELEASE' ? 5000n : 0n,
    );
  });
});
