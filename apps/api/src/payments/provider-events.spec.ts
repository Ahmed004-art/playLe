import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  finishProviderEvent,
  recordProviderEvent,
  sameJson,
} from './provider-events.js';

/**
 * `recordProviderEvent` / `finishProviderEvent` (Phase 13): a redelivery of an
 * event whose first attempt never finished (`RECEIVED`) is handed back for
 * processing; anything already finished, or a redelivery whose content differs
 * from what was stored, is not. The unique `(provider, providerEventId)` index
 * is modelled by a P2002 on the second create, as Postgres raises it.
 */

const P2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint', {
    code: 'P2002',
    clientVersion: 'test',
  });

function harness(stored?: {
  id: string;
  status: string;
  eventType: string;
  payload: unknown;
}) {
  const prisma = {
    providerEvent: {
      create: vi.fn(() =>
        stored
          ? Promise.reject(P2002())
          : Promise.resolve({ id: 'pe-new', status: 'RECEIVED' }),
      ),
      findUnique: vi.fn(() => Promise.resolve(stored ?? null)),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
    },
  };
  const logger = { log: vi.fn(), warn: vi.fn() };
  const record = (eventType: string, payload: unknown) =>
    recordProviderEvent(
      prisma as never,
      logger as never,
      'FAKE',
      'evt-1',
      eventType,
      payload,
    );
  return { prisma, logger, record };
}

const payload = { eventType: 'deposit.completed', providerReference: 'pmc-1' };

describe('recordProviderEvent', () => {
  it('stores a first delivery as RECEIVED and hands it over', async () => {
    const h = harness();

    expect(await h.record('deposit.completed', payload)).toEqual({
      id: 'pe-new',
      recovered: false,
    });
    expect(h.prisma.providerEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: 'FAKE',
        providerEventId: 'evt-1',
        status: 'RECEIVED',
      }),
    });
  });

  it('hands back an unfinished (RECEIVED) event whose redelivery matches it', async () => {
    const h = harness({
      id: 'pe-1',
      status: 'RECEIVED',
      eventType: 'deposit.completed',
      // jsonb comes back with its keys reordered
      payload: { providerReference: 'pmc-1', eventType: 'deposit.completed' },
    });

    expect(await h.record('deposit.completed', payload)).toEqual({
      id: 'pe-1',
      recovered: true,
    });
    expect(h.prisma.providerEvent.findUnique).toHaveBeenCalledWith({
      where: {
        provider_providerEventId: {
          provider: 'FAKE',
          providerEventId: 'evt-1',
        },
      },
    });
  });

  it.each(['PROCESSED', 'IGNORED', 'REJECTED'])(
    'never hands back an event already %s',
    async (status) => {
      const h = harness({
        id: 'pe-1',
        status,
        eventType: 'deposit.completed',
        payload,
      });

      expect(await h.record('deposit.completed', payload)).toBeNull();
    },
  );

  it('refuses a redelivery whose payload differs from the stored, unfinished event', async () => {
    const h = harness({
      id: 'pe-1',
      status: 'RECEIVED',
      eventType: 'deposit.completed',
      payload,
    });

    expect(
      await h.record('deposit.completed', {
        ...payload,
        providerReference: 'pmc-OTHER',
      }),
    ).toBeNull();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('compares the redelivery as it would be stored: an undefined key does not count as a difference', async () => {
    // Prisma drops `reason: undefined` when writing the JSON column, so the
    // stored row lacks the key while the freshly parsed redelivery has it.
    const h = harness({
      id: 'pe-1',
      status: 'RECEIVED',
      eventType: 'deposit.completed',
      payload,
    });

    expect(
      await h.record('deposit.completed', { ...payload, reason: undefined }),
    ).toEqual({ id: 'pe-1', recovered: true });
  });

  it('refuses a redelivery whose event type differs', async () => {
    const h = harness({
      id: 'pe-1',
      status: 'RECEIVED',
      eventType: 'deposit.completed',
      payload,
    });

    expect(await h.record('deposit.failed', payload)).toBeNull();
  });

  it('rethrows any other database error', async () => {
    const h = harness();
    h.prisma.providerEvent.create.mockRejectedValueOnce(new Error('db down'));

    await expect(h.record('deposit.completed', payload)).rejects.toThrow(
      'db down',
    );
  });
});

describe('finishProviderEvent', () => {
  it('only moves an event out of RECEIVED, never over a final status', async () => {
    const h = harness();

    await finishProviderEvent(h.prisma as never, 'pe-1', {
      status: 'PROCESSED',
      relatedDepositId: 'deposit-1',
    });

    expect(h.prisma.providerEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'pe-1', status: 'RECEIVED' },
      data: expect.objectContaining({
        status: 'PROCESSED',
        relatedDepositId: 'deposit-1',
        processedAt: expect.any(Date),
      }),
    });
  });
});

describe('sameJson', () => {
  it('ignores object key order', () => {
    expect(
      sameJson({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }),
    ).toBe(true);
  });

  it.each([
    [{ a: 1 }, { a: 2 }],
    [{ a: 1 }, { a: 1, b: 2 }],
    [{ a: [1, 2] }, { a: [2, 1] }],
    [{ a: '1' }, { a: 1 }],
    [{ a: null }, { a: {} }],
    [[], {}],
  ])('tells %o and %o apart', (a, b) => {
    expect(sameJson(a, b)).toBe(false);
  });
});
