import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentReconciliationService } from './payment-reconciliation.service.js';
import {
  LONGEST_FINANCIAL_TRANSACTION_MS,
  PROVIDER_EVENT_STALE_DEFAULT_MS,
  PROVIDER_EVENT_STALE_MAX_MS,
  PROVIDER_EVENT_STALE_MIN_MS,
  STUCK_PROCESSING_THRESHOLD_MS,
} from './reconciliation.constants.js';

/**
 * `findStaleReceivedEvents` and the dedupe in `runOnce` (Phase 13). The
 * database is a fake that applies the filters the code sends (status and the
 * strict `createdAt < cutoff`, and the anomaly table's OPEN / related-id /
 * JSON-path match), so what is asserted is the selection and dedupe behaviour,
 * not just the shape of a query. The behaviour against Postgres - including the
 * JSON path filter itself - is `test/payments-phase6.e2e-spec.ts` (CI only).
 */

const NOW = new Date('2026-10-27T12:00:00.000Z');
const STALE_MS = 15 * 60_000;

interface EventRow {
  provider: string;
  providerEventId: string;
  eventType: string;
  payload: unknown;
  status: string;
  createdAt: Date;
}
interface AnomalyRow {
  id: string;
  type: string;
  status: string;
  relatedDepositId: string | null;
  relatedWithdrawalId: string | null;
  details: { detail: string; eventKey?: string };
}
interface RefRow {
  id: string;
  providerReference: string;
}
type RefQuery = { where: { providerReference?: { in: string[] } } };

const event = (over: Partial<EventRow> & { ageMs: number }): EventRow => {
  const { ageMs, ...rest } = over;
  return {
    provider: 'FAKE',
    providerEventId: 'evt-1',
    eventType: 'deposit.completed',
    payload: { eventType: 'deposit.completed', providerReference: 'ref-1' },
    status: 'RECEIVED',
    createdAt: new Date(NOW.getTime() - ageMs),
    ...rest,
  };
};

/** Answers a `providerReference IN (...)` lookup; any other query finds nothing. */
const byReference = (rows: RefRow[]) =>
  vi.fn((args: RefQuery) => {
    const wanted = args.where.providerReference?.in;
    return Promise.resolve(
      wanted ? rows.filter((r) => wanted.includes(r.providerReference)) : [],
    );
  });

function build(
  events: EventRow[],
  deposits: RefRow[] = [],
  withdrawals: RefRow[] = [],
  staleAfterMs = STALE_MS,
) {
  const anomalies: AnomalyRow[] = [];
  const staleQuery = vi.fn(
    (args: { where: { status: string; createdAt: { lt: Date } } }) =>
      Promise.resolve(
        events
          .filter(
            (e) =>
              e.status === args.where.status &&
              e.createdAt < args.where.createdAt.lt,
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      ),
  );
  const prisma = {
    providerEvent: {
      // Only the stale check asks for RECEIVED events; every other check's
      // query is answered with nothing so it contributes no anomaly.
      findMany: vi.fn((args: { where: { status?: string } }) =>
        args.where.status === 'RECEIVED'
          ? staleQuery(args as never)
          : Promise.resolve([]),
      ),
    },
    deposit: {
      findMany: byReference(deposits),
      groupBy: vi.fn(() => Promise.resolve([])),
    },
    withdrawal: {
      findMany: byReference(withdrawals),
      groupBy: vi.fn(() => Promise.resolve([])),
    },
    providerOperation: { findMany: vi.fn(() => Promise.resolve([])) },
    paymentReconciliationAnomaly: {
      findFirst: vi.fn(
        (args: {
          where: {
            type: string;
            status: string;
            relatedDepositId: string | null;
            relatedWithdrawalId: string | null;
            details?: { path: string[]; equals: string };
          };
        }) => {
          const w = args.where;
          return Promise.resolve(
            anomalies.find(
              (a) =>
                a.type === w.type &&
                a.status === w.status &&
                a.relatedDepositId === w.relatedDepositId &&
                a.relatedWithdrawalId === w.relatedWithdrawalId &&
                (!w.details || a.details.eventKey === w.details.equals),
            ) ?? null,
          );
        },
      ),
      create: vi.fn(
        (args: {
          data: {
            type: string;
            relatedDepositId?: string;
            relatedWithdrawalId?: string;
            details: { detail: string; eventKey?: string };
          };
        }) => {
          const row: AnomalyRow = {
            id: `an-${anomalies.length + 1}`,
            type: args.data.type,
            status: 'OPEN',
            relatedDepositId: args.data.relatedDepositId ?? null,
            relatedWithdrawalId: args.data.relatedWithdrawalId ?? null,
            details: args.data.details,
          };
          anomalies.push(row);
          return Promise.resolve(row);
        },
      ),
    },
  };
  const config = { get: vi.fn(() => staleAfterMs) };
  const service = new PaymentReconciliationService(
    prisma as never,
    config as never,
  );
  const stale = async () =>
    (await service.runOnce()).anomalies.filter(
      (a) => a.type === 'STALE_PROVIDER_EVENT',
    );
  return { service, prisma, anomalies, config, staleQuery, stale };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('stale RECEIVED provider events - selection', () => {
  it('asks only for RECEIVED events strictly older than the configured age', async () => {
    const h = build([]);

    await h.service.runOnce();

    expect(h.staleQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'RECEIVED',
          createdAt: { lt: new Date(NOW.getTime() - STALE_MS) },
        },
      }),
    );
    expect(h.config.get).toHaveBeenCalledWith(
      'payments.providerEventStaleAfterMs',
      { infer: true },
    );
  });

  it('reports an event just over the threshold', async () => {
    const h = build([event({ ageMs: STALE_MS + 1 })]);
    expect(await h.stale()).toHaveLength(1);
  });

  it('does not report an event exactly at the threshold (boundary is strict)', async () => {
    const h = build([event({ ageMs: STALE_MS })]);
    expect(await h.stale()).toHaveLength(0);
  });

  it('does not report an event just under the threshold', async () => {
    const h = build([event({ ageMs: STALE_MS - 1 })]);
    expect(await h.stale()).toHaveLength(0);
  });

  it.each(['PROCESSED', 'IGNORED', 'REJECTED'])(
    'never reports an old %s event',
    async (status) => {
      const h = build([event({ ageMs: 3 * STALE_MS, status })]);
      expect(await h.stale()).toHaveLength(0);
    },
  );

  it('uses the configured threshold', async () => {
    const h = build([event({ ageMs: 20 * 60_000 })], [], [], 30 * 60_000);
    expect(await h.stale()).toHaveLength(0);

    const h2 = build([event({ ageMs: 31 * 60_000 })], [], [], 30 * 60_000);
    expect(await h2.stale()).toHaveLength(1);
  });
});

describe('stale RECEIVED provider events - related record', () => {
  it('relates a deposit event to its deposit through the payload reference', async () => {
    const h = build(
      [event({ ageMs: 2 * STALE_MS })],
      [{ id: 'deposit-1', providerReference: 'ref-1' }],
    );

    const [anomaly] = await h.stale();

    expect(anomaly).toMatchObject({
      type: 'STALE_PROVIDER_EVENT',
      relatedDepositId: 'deposit-1',
    });
    expect(anomaly.relatedWithdrawalId).toBeUndefined();
    expect(anomaly.eventKey).toBeUndefined();
    expect(anomaly.detail).toContain('FAKE/evt-1');
    expect(anomaly.detail).toContain('Nothing was reprocessed');
  });

  it('relates a payout event to its withdrawal, not to a deposit with the same reference', async () => {
    const h = build(
      [
        event({
          ageMs: 2 * STALE_MS,
          eventType: 'payout.completed',
          payload: {
            eventType: 'payout.completed',
            providerReference: 'ref-1',
          },
        }),
      ],
      [{ id: 'deposit-1', providerReference: 'ref-1' }],
      [{ id: 'wd-1', providerReference: 'ref-1' }],
    );

    const [anomaly] = await h.stale();

    expect(anomaly).toMatchObject({ relatedWithdrawalId: 'wd-1' });
    expect(anomaly.relatedDepositId).toBeUndefined();
  });

  it('folds several events for one deposit into one anomaly that names them all', async () => {
    const h = build(
      [
        event({ ageMs: 2 * STALE_MS, providerEventId: 'evt-1' }),
        event({ ageMs: 3 * STALE_MS, providerEventId: 'evt-2' }),
      ],
      [{ id: 'deposit-1', providerReference: 'ref-1' }],
    );

    const anomalies = await h.stale();

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].detail).toContain('evt-1');
    expect(anomalies[0].detail).toContain('evt-2');
  });

  it.each([
    ['no provider reference', { eventType: 'deposit.completed' }],
    ['a non-string provider reference', { providerReference: 42 }],
    ['an empty provider reference', { providerReference: '' }],
    ['a payload that is not an object', 'garbage'],
    ['a null payload', null],
  ])('keys an event with %s on the event itself', async (_name, payload) => {
    const h = build([event({ ageMs: 2 * STALE_MS, payload })]);

    const [anomaly] = await h.stale();

    expect(anomaly).toMatchObject({ eventKey: 'FAKE/evt-1' });
    expect(anomaly.relatedDepositId).toBeUndefined();
    expect(anomaly.relatedWithdrawalId).toBeUndefined();
  });

  it('keys an event whose reference matches nothing on the event itself', async () => {
    const h = build(
      [event({ ageMs: 2 * STALE_MS })],
      [{ id: 'deposit-9', providerReference: 'other-ref' }],
    );

    expect((await h.stale())[0]).toMatchObject({ eventKey: 'FAKE/evt-1' });
  });

  it('only reads records and writes only anomaly rows', async () => {
    const h = build(
      [event({ ageMs: 2 * STALE_MS })],
      [{ id: 'deposit-1', providerReference: 'ref-1' }],
    );

    await h.service.runOnce();

    // The fake models expose reads only for events, deposits and withdrawals,
    // so any update, delete or upsert on them would throw; the one write that
    // happened is the anomaly insert.
    for (const model of [
      h.prisma.providerEvent,
      h.prisma.deposit,
      h.prisma.withdrawal,
    ]) {
      expect(
        Object.keys(model).every((k) => k === 'findMany' || k === 'groupBy'),
      ).toBe(true);
    }
    expect(h.prisma.paymentReconciliationAnomaly.create).toHaveBeenCalledTimes(
      1,
    );
  });
});

describe('stale RECEIVED provider events - deduplication', () => {
  it('records a related-record anomaly once however many runs find it', async () => {
    const h = build(
      [event({ ageMs: 2 * STALE_MS })],
      [{ id: 'deposit-1', providerReference: 'ref-1' }],
    );

    const first = await h.service.runOnce();
    const second = await h.service.runOnce();
    const third = await h.service.runOnce();

    expect(first.newlyRecorded).toBe(1);
    expect(second.newlyRecorded).toBe(0);
    expect(third.newlyRecorded).toBe(0);
    expect(h.anomalies).toHaveLength(1);
  });

  it('keeps different unmatched events independent: one anomaly each', async () => {
    const h = build([
      event({ ageMs: 2 * STALE_MS, providerEventId: 'evt-1' }),
      event({ ageMs: 3 * STALE_MS, providerEventId: 'evt-2' }),
      event({ ageMs: 4 * STALE_MS, providerEventId: 'evt-3' }),
    ]);

    const first = await h.service.runOnce();
    expect(first.newlyRecorded).toBe(3);
    expect(h.anomalies.map((a) => a.details.eventKey).sort()).toEqual([
      'FAKE/evt-1',
      'FAKE/evt-2',
      'FAKE/evt-3',
    ]);

    expect((await h.service.runOnce()).newlyRecorded).toBe(0);
    expect(h.anomalies).toHaveLength(3);
  });

  it('looks for an open anomaly by the event key, so another event cannot hide behind it', async () => {
    const h = build([
      event({ ageMs: 2 * STALE_MS, providerEventId: 'evt-1' }),
      event({ ageMs: 3 * STALE_MS, providerEventId: 'evt-2' }),
    ]);

    await h.service.runOnce();

    expect(
      h.prisma.paymentReconciliationAnomaly.findFirst,
    ).toHaveBeenCalledWith({
      where: expect.objectContaining({
        type: 'STALE_PROVIDER_EVENT',
        status: 'OPEN',
        relatedDepositId: null,
        relatedWithdrawalId: null,
        details: { path: ['eventKey'], equals: 'FAKE/evt-1' },
      }),
    });
  });

  it('raises a new anomaly after the old one was resolved while the event is still stale', async () => {
    const h = build([event({ ageMs: 2 * STALE_MS })]);
    await h.service.runOnce();
    h.anomalies[0].status = 'RESOLVED';

    const again = await h.service.runOnce();

    expect(again.newlyRecorded).toBe(1);
    expect(h.anomalies).toHaveLength(2);
    expect(h.anomalies.filter((a) => a.status === 'OPEN')).toHaveLength(1);
  });

  it('stops reporting an event once it is finished, leaving the earlier anomaly untouched', async () => {
    const row = event({ ageMs: 2 * STALE_MS });
    const h = build([row]);
    await h.service.runOnce();

    row.status = 'PROCESSED';
    const after = await h.service.runOnce();

    expect(
      after.anomalies.filter((a) => a.type === 'STALE_PROVIDER_EVENT'),
    ).toEqual([]);
    expect(after.newlyRecorded).toBe(0);
    expect(h.anomalies).toHaveLength(1);
    expect(h.anomalies[0].status).toBe('OPEN');
  });
});

describe('PROVIDER_EVENT_STALE_AFTER_MS bounds', () => {
  it('sits far above the longest a money transaction can run', () => {
    expect(LONGEST_FINANCIAL_TRANSACTION_MS).toBe(15_000);
    expect(PROVIDER_EVENT_STALE_MIN_MS).toBeGreaterThanOrEqual(
      20 * LONGEST_FINANCIAL_TRANSACTION_MS,
    );
  });

  it('stays below the stuck-withdrawal threshold, with the default inside the bounds', () => {
    expect(PROVIDER_EVENT_STALE_MAX_MS).toBeLessThan(
      STUCK_PROCESSING_THRESHOLD_MS,
    );
    expect(PROVIDER_EVENT_STALE_DEFAULT_MS).toBe(15 * 60_000);
    expect(PROVIDER_EVENT_STALE_DEFAULT_MS).toBeGreaterThanOrEqual(
      PROVIDER_EVENT_STALE_MIN_MS,
    );
    expect(PROVIDER_EVENT_STALE_DEFAULT_MS).toBeLessThanOrEqual(
      PROVIDER_EVENT_STALE_MAX_MS,
    );
  });
});
