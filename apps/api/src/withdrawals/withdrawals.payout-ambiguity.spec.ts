import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonimeProvider } from '../payments/providers/monime.provider.js';
import { WithdrawalsService } from './withdrawals.service.js';

/**
 * OUTSTANDING_WORK item 29: a payout whose outcome cannot be ruled out must
 * keep the user's funds held.
 *
 * The real `MonimeProvider` (only `fetch` is stubbed) runs under the real
 * `WithdrawalsService`, so each case covers the whole path from the HTTP answer
 * to the wallet and the ledger. The database is an in-memory model of what the
 * code relies on: conditional `updateMany` claims, transaction rollback, a
 * wallet row lock held until the transaction ends, and a non-negative balance.
 * Postgres behaviour is `test/payments-phase6.e2e-spec.ts`.
 */

const AMOUNT = 4000n;
/** Another withdrawal's hold, so a double release cannot hide behind the non-negative check. */
const OTHER_HOLD = 5000n;
const FREE = 6000n;

type Row = Record<string, unknown> & { id: string; status: string };

interface Where {
  id?: string;
  kind?: string;
  relatedWithdrawalId?: string;
  status?: string | { in?: string[]; not?: string };
}

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (want !== null && typeof want === 'object') {
      const filter = want as { in?: string[]; not?: string };
      if (filter.in) return filter.in.includes(row[key] as string);
      return row[key] !== filter.not;
    }
    return row[key] === want;
  });
}

function build() {
  const db = {
    withdrawal: {
      id: 'wd-1',
      userId: 'user-1',
      walletId: 'wallet-1',
      amountMinor: AMOUNT,
      currency: 'SLE',
      status: 'PENDING_REVIEW',
      providerReference: null as string | null,
      destinationDetails: {
        method: 'ORANGE_MONEY',
        phoneNumber: '+23276000000',
      },
    },
    available: FREE,
    held: AMOUNT + OTHER_HOLD,
    entries: [] as string[],
    operations: [] as Row[],
    events: [] as Row[],
  };

  type Journal = { undo: Array<() => void>; release?: () => void };
  let lockTail: Promise<void> = Promise.resolve();
  const journals = new WeakMap<object, Journal>();

  const withdrawalModel = (journal?: Journal) => ({
    findUnique: () => Promise.resolve({ ...db.withdrawal }),
    findFirst: ({ where }: { where: { providerReference: string } }) =>
      Promise.resolve(
        db.withdrawal.providerReference === where.providerReference
          ? { ...db.withdrawal }
          : null,
      ),
    findUniqueOrThrow: () => Promise.resolve({ ...db.withdrawal }),
    updateMany: ({ where, data }: { where: Where; data: object }) => {
      if (!matches(db.withdrawal, where)) return Promise.resolve({ count: 0 });
      const previous = { ...db.withdrawal };
      Object.assign(db.withdrawal, data);
      journal?.undo.push(() => Object.assign(db.withdrawal, previous));
      return Promise.resolve({ count: 1 });
    },
  });

  const operationModel = (journal?: Journal) => ({
    create: ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: `op-${db.operations.length + 1}`,
        ...data,
      } as unknown as Row;
      db.operations.push(row);
      journal?.undo.push(() => {
        db.operations.splice(db.operations.indexOf(row), 1);
      });
      return Promise.resolve({ ...row });
    },
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = db.operations.find((o) => o.id === where.id)!;
      const previous = { ...row };
      Object.assign(row, data);
      journal?.undo.push(() => Object.assign(row, previous));
      return Promise.resolve({ ...row });
    },
    findMany: ({ where }: { where: Where }) =>
      Promise.resolve(
        db.operations.filter((o) => matches(o, where)).map((o) => ({ ...o })),
      ),
  });

  const prisma = {
    withdrawal: withdrawalModel(),
    providerOperation: operationModel(),
    providerEvent: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        if (db.events.some((e) => e.providerEventId === data.providerEventId)) {
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError('duplicate', {
              code: 'P2002',
              clientVersion: 'test',
            }),
          );
        }
        const row = {
          id: `ev-${db.events.length + 1}`,
          ...data,
        } as unknown as Row;
        db.events.push(row);
        return Promise.resolve({ ...row });
      },
      findUnique: ({
        where,
      }: {
        where: { provider_providerEventId: { providerEventId: string } };
      }) =>
        Promise.resolve(
          db.events.find(
            (e) =>
              e.providerEventId ===
              where.provider_providerEventId.providerEventId,
          ) ?? null,
        ),
      updateMany: ({ where, data }: { where: Where; data: object }) => {
        const rows = db.events.filter((e) => matches(e, where));
        rows.forEach((row) => Object.assign(row, data));
        return Promise.resolve({ count: rows.length });
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const journal: Journal = { undo: [] };
      const tx = {
        withdrawal: withdrawalModel(journal),
        providerOperation: operationModel(journal),
      };
      journals.set(tx, journal);
      try {
        return await fn(tx);
      } catch (error) {
        journal.undo.reverse().forEach((step) => step());
        throw error;
      } finally {
        journal.release?.();
      }
    },
  };

  const ledgerService = {
    lockWallet: async (tx: object) => {
      const journal = journals.get(tx)!;
      if (journal.release) return;
      const previous = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>((resolve) => (release = resolve));
      await previous;
      journal.release = release;
    },
    applyEntry: async (
      tx: object,
      _walletId: string,
      entry: {
        type: string;
        availableDeltaMinor: bigint;
        heldDeltaMinor: bigint;
      },
    ) => {
      await ledgerService.lockWallet(tx);
      const available = db.available + entry.availableDeltaMinor;
      const held = db.held + entry.heldDeltaMinor;
      if (available < 0n || held < 0n) throw new Error('Insufficient balance');
      const before = { available: db.available, held: db.held };
      db.available = available;
      db.held = held;
      db.entries.push(entry.type);
      journals.get(tx)!.undo.push(() => {
        Object.assign(db, before);
        db.entries.pop();
      });
    },
  };

  const provider = new MonimeProvider({
    get: () => ({
      monimeApiKey: 'mon_test_abc',
      monimeSpaceId: 'spc-123',
      monimeBaseUrl: 'https://monime.invalid',
      monimeHttpTimeoutMs: 1000,
      monimeLivePaymentsEnabled: false,
    }),
  } as never);

  const notificationOutbox = {
    enqueue: vi.fn(() => Promise.resolve()),
    enqueueStandalone: vi.fn(() => Promise.resolve()),
  };

  const adminAudit = { record: vi.fn(() => Promise.resolve()) };

  const service = new WithdrawalsService(
    prisma as never,
    ledgerService as never,
    {} as never,
    {} as never,
    provider,
    notificationOutbox as never,
    adminAudit as never,
  );

  /** The next webhook delivery verifies (the real provider rejects every one today). */
  const deliver = (
    eventId: string,
    eventType: 'payout.completed' | 'payout.failed',
    providerReference: string,
  ) => {
    vi.spyOn(provider, 'verifyWebhookSignature').mockReturnValue({
      valid: true,
      providerEventId: eventId,
      eventType,
      parsedPayload: { eventType, providerReference },
    });
    return service.processProviderWebhook('{}', {});
  };

  return { db, service, notificationOutbox, deliver, adminAudit };
}

type Harness = ReturnType<typeof build>;

const json = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const text = (status: number, body: string) => () =>
  Promise.resolve(new Response(body, { status }));
const payout = (status: string, id = 'pyt-1') =>
  json(200, { success: true, result: { id, status } });
const throws = (error: Error) => () => Promise.reject(error);

function stubFetch(...answers: Array<() => Promise<Response>>) {
  const spy = vi.spyOn(globalThis, 'fetch');
  for (const answer of answers) spy.mockImplementationOnce(answer);
  // Anything not scripted is a test failure, never a real network call.
  spy.mockImplementation(() => Promise.reject(new Error('unscripted fetch')));
  return spy;
}

const posts = (spy: ReturnType<typeof stubFetch>) =>
  spy.mock.calls.filter(([, init]) => init?.method === 'POST');

const approve = (h: Harness) =>
  h.service.approve('admin-1', 'wd-1', 'Verified identity');
const adminFail = (h: Harness) =>
  h.service.fail('admin-1', 'wd-1', 'Payout did not arrive');
const adminComplete = (h: Harness, admin = 'admin-1') =>
  h.service.complete(admin, 'wd-1', 'Recipient confirmed payment');

const submissions = (h: Harness) =>
  h.db.operations.filter((o) => o.kind === 'PAYOUT_SUBMIT');

function expectHeld(h: Harness, status = 'PROCESSING'): void {
  expect(h.db.entries).toEqual([]);
  expect(h.db.available).toBe(FREE);
  expect(h.db.held).toBe(AMOUNT + OTHER_HOLD);
  expect(h.db.withdrawal.status).toBe(status);
}

function expectReleasedOnce(h: Harness): void {
  expect(h.db.entries).toEqual(['RELEASE']);
  expect(h.db.available).toBe(FREE + AMOUNT);
  expect(h.db.held).toBe(OTHER_HOLD);
  expect(h.db.withdrawal.status).toBe('FAILED');
}

function expectPaidOnce(h: Harness): void {
  expect(h.db.entries).toEqual(['WITHDRAWAL']);
  expect(h.db.available).toBe(FREE);
  expect(h.db.held).toBe(OTHER_HOLD);
  expect(h.db.withdrawal.status).toBe('COMPLETED');
}

afterEach(() => vi.restoreAllMocks());

const AMBIGUOUS: Array<[string, () => Promise<Response>]> = [
  ...[400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504].map(
    (status): [string, () => Promise<Response>] => [
      `HTTP ${status}`,
      json(status, { success: false }),
    ],
  ),
  ['HTTP 504 with a non-JSON body', text(504, '<html>Gateway Timeout</html>')],
  [
    'a timeout after the request was sent',
    throws(new DOMException('timed out', 'TimeoutError')),
  ],
  [
    'a connection reset after submission',
    throws(new TypeError('fetch failed: ECONNRESET')),
  ],
  ['an unreadable success response', text(200, 'not json')],
  ['an empty success response', text(200, '')],
  ['a success response with no result', json(200, { success: true })],
  [
    'a success response with no payout id',
    json(200, { result: { status: 'completed' } }),
  ],
  [
    'a "failed" success response with no payout id',
    json(200, { result: { status: 'failed' } }),
  ],
];

describe('an ambiguous payout submission keeps the funds held', () => {
  it.each(AMBIGUOUS)('%s', async (_name, answer) => {
    const h = build();
    const fetchSpy = stubFetch(answer);

    await approve(h);

    expectHeld(h);
    expect(submissions(h)).toEqual([
      expect.objectContaining({ status: 'UNKNOWN' }),
    ]);
    expect(submissions(h)[0].resolvedAt ?? null).toBeNull();
    expect(posts(fetchSpy)).toHaveLength(1);
    expect(h.notificationOutbox.enqueue).not.toHaveBeenCalled();
    expect(h.notificationOutbox.enqueueStandalone).not.toHaveBeenCalled();
  });

  it('a success response with an unrecognised status keeps the payout reference for recovery', async () => {
    const h = build();
    stubFetch(payout('mystery'));

    await approve(h);

    expectHeld(h);
    expect(h.db.withdrawal.providerReference).toBe('pyt-1');
    expect(submissions(h)[0].status).toBe('UNKNOWN');
  });
});

describe('a definitive provider failure still releases the hold', () => {
  it('releases once when the provider reports the payout "failed"', async () => {
    const h = build();
    stubFetch(payout('failed'));

    await approve(h);

    expectReleasedOnce(h);
    expect(submissions(h)[0].status).toBe('FAILED');
  });

  it('a request that was never sent leaves the manual flow available', async () => {
    const h = build();
    h.db.withdrawal.destinationDetails = { method: 'UNSUPPORTED' } as never;
    const fetchSpy = stubFetch();

    await approve(h);
    expectHeld(h, 'APPROVED');
    expect(fetchSpy).not.toHaveBeenCalled();

    await adminFail(h);
    expectReleasedOnce(h);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('an administrator cannot release an unresolved payout', () => {
  async function expectRefused(h: Harness, status = 'PROCESSING') {
    await expect(adminFail(h)).rejects.toBeInstanceOf(ConflictException);
    expectHeld(h, status);
  }

  it('refuses when the response was lost and there is no payout reference', async () => {
    const h = build();
    const fetchSpy = stubFetch(throws(new TypeError('fetch failed')));
    await approve(h);

    await expectRefused(h);
    await expectRefused(h);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses while the payout request is still in flight', async () => {
    const h = build();
    let respond!: (r: Response) => void;
    let sent!: () => void;
    const wasSent = new Promise<void>((resolve) => (sent = resolve));
    stubFetch(() => {
      sent();
      return new Promise<Response>((resolve) => (respond = resolve));
    });
    const approval = approve(h);
    await wasSent;

    await expectRefused(h, 'APPROVED');

    respond(await payout('completed')());
    await approval;
    expectPaidOnce(h);
  });

  it.each([
    ['still pending', payout('pending')],
    ['still processing', payout('processing')],
    ['unreadable', text(200, 'not json')],
    ['HTTP 500', json(500, {})],
    ['HTTP 404', json(404, {})],
    ['a network error', throws(new TypeError('fetch failed'))],
    ['"failed" for a different payout', payout('failed', 'pyt-other')],
  ])('refuses when the status check is %s', async (_name, check) => {
    const h = build();
    stubFetch(payout('pending'), check);
    await approve(h);

    await expectRefused(h);
  });

  it('refuses, and says to complete instead, when the provider reports the payout completed', async () => {
    const h = build();
    stubFetch(payout('pending'), payout('completed'));
    await approve(h);

    await expect(adminFail(h)).rejects.toThrow(/completed/i);
    expectHeld(h);
  });

  it('records every status check, with who asked and why', async () => {
    const h = build();
    stubFetch(payout('pending'), payout('pending'));
    await approve(h);
    await expectRefused(h);

    expect(
      h.db.operations.filter((o) => o.kind === 'PAYOUT_STATUS_CHECK'),
    ).toEqual([
      expect.objectContaining({
        status: 'PENDING',
        relatedWithdrawalId: 'wd-1',
        requestSnapshot: {
          providerReference: 'pyt-1',
          adminId: 'admin-1',
          reason: 'Payout did not arrive',
        },
      }),
    ]);
  });
});

describe('recovery', () => {
  it('releases once after a status check confirms the payout failed', async () => {
    const h = build();
    const fetchSpy = stubFetch(payout('pending'), payout('failed'));
    await approve(h);

    await adminFail(h);

    expectReleasedOnce(h);
    expect(submissions(h)[0].status).toBe('FAILED');
    expect(h.db.withdrawal).toMatchObject({
      reviewedByAdminId: 'admin-1',
      reviewReason: 'Payout did not arrive',
    });
    expect(posts(fetchSpy)).toHaveLength(1);

    await expect(adminFail(h)).rejects.toBeInstanceOf(ConflictException);
    await h.deliver('evt-late', 'payout.failed', 'pyt-1');
    expectReleasedOnce(h);
  });

  it('two concurrent admin failures release once', async () => {
    const h = build();
    stubFetch(payout('pending'), payout('failed'), payout('failed'));
    await approve(h);

    const results = await Promise.allSettled([adminFail(h), adminFail(h)]);

    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expectReleasedOnce(h);
  });

  it('a payout.failed event releases once however often it is delivered', async () => {
    const h = build();
    stubFetch(payout('pending'));
    await approve(h);

    await h.deliver('evt-1', 'payout.failed', 'pyt-1');
    await h.deliver('evt-1', 'payout.failed', 'pyt-1');
    await h.deliver('evt-2', 'payout.failed', 'pyt-1');
    await h.deliver('evt-3', 'payout.completed', 'pyt-1');

    expectReleasedOnce(h);
  });

  it('a payout.completed event debits the hold once and never releases it', async () => {
    const h = build();
    stubFetch(payout('pending'));
    await approve(h);

    await h.deliver('evt-1', 'payout.completed', 'pyt-1');
    await h.deliver('evt-1', 'payout.completed', 'pyt-1');
    await h.deliver('evt-2', 'payout.failed', 'pyt-1');
    await expect(adminFail(h)).rejects.toBeInstanceOf(ConflictException);

    expectPaidOnce(h);
  });

  it('a payout whose response was lost can be neither completed nor released in-app', async () => {
    const h = build();
    const fetchSpy = stubFetch(throws(new TypeError('socket hang up')));
    await approve(h);

    await expect(adminFail(h)).rejects.toBeInstanceOf(ConflictException);
    await expect(adminComplete(h)).rejects.toBeInstanceOf(ConflictException);

    expectHeld(h);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('the original idempotency key is never replaced', () => {
  it('sends one request, under the stored key, however often submission is retried', async () => {
    const h = build();
    const fetchSpy = stubFetch(json(500, {}));
    await approve(h);
    const key = submissions(h)[0].providerIdempotencyKey;

    await h.service.submitPayout('wd-1');
    await expect(approve(h)).rejects.toBeInstanceOf(ConflictException);

    expect(posts(fetchSpy)).toHaveLength(1);
    expect(
      (posts(fetchSpy)[0][1]!.headers as Record<string, string>)[
        'Idempotency-Key'
      ],
    ).toBe(key);
    expect(submissions(h)).toHaveLength(1);
    expect(submissions(h)[0].providerIdempotencyKey).toBe(key);
    expectHeld(h);
  });

  it('does not resubmit an interrupted attempt still recorded as PENDING', async () => {
    const h = build();
    const fetchSpy = stubFetch();
    // A crash after the request was sent: still APPROVED, operation PENDING.
    h.db.withdrawal.status = 'APPROVED';
    h.db.operations.push({
      id: 'op-1',
      kind: 'PAYOUT_SUBMIT',
      status: 'PENDING',
      provider: 'MONIME',
      relatedWithdrawalId: 'wd-1',
      providerIdempotencyKey: 'original-key',
    });

    await h.service.submitPayout('wd-1');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(submissions(h)).toHaveLength(1);
    await expect(adminFail(h)).rejects.toBeInstanceOf(ConflictException);
    expectHeld(h, 'APPROVED');
  });

  it('concurrent submissions of one approved withdrawal send one request', async () => {
    const h = build();
    h.db.withdrawal.status = 'APPROVED';
    const fetchSpy = stubFetch(payout('pending'), payout('pending'));

    await Promise.all([
      h.service.submitPayout('wd-1'),
      h.service.submitPayout('wd-1'),
    ]);

    expect(posts(fetchSpy)).toHaveLength(1);
    expect(submissions(h)).toHaveLength(1);
  });
});

describe('an administrator cannot complete an unresolved payout (H1)', () => {
  const refused = (h: Harness) =>
    expect(h.adminAudit.record).toHaveBeenCalledWith(
      'WITHDRAWAL_FINALIZE_REFUSED',
      expect.objectContaining({
        adminId: 'admin-1',
        detail: expect.stringContaining('wd-1'),
      }),
    );

  it('refuses while the request is in flight, and the provider failure then releases once', async () => {
    const h = build();
    let respond!: (r: Response) => void;
    let sent!: () => void;
    const wasSent = new Promise<void>((resolve) => (sent = resolve));
    stubFetch(() => {
      sent();
      return new Promise<Response>((resolve) => (respond = resolve));
    });
    const approval = approve(h);
    await wasSent;

    await expect(adminComplete(h)).rejects.toBeInstanceOf(ConflictException);
    expectHeld(h, 'APPROVED');
    refused(h);

    respond(await payout('failed')());
    await approval;
    expectReleasedOnce(h);
  });

  it('refuses while the request is in flight, and the provider success then debits once', async () => {
    const h = build();
    let respond!: (r: Response) => void;
    let sent!: () => void;
    const wasSent = new Promise<void>((resolve) => (sent = resolve));
    stubFetch(() => {
      sent();
      return new Promise<Response>((resolve) => (respond = resolve));
    });
    const approval = approve(h);
    await wasSent;

    await expect(adminComplete(h)).rejects.toBeInstanceOf(ConflictException);

    respond(await payout('completed')());
    await approval;
    expectPaidOnce(h);
  });

  it('refuses, every time and with an audit record, after an ambiguous timeout', async () => {
    const h = build();
    const fetchSpy = stubFetch(
      throws(new DOMException('timed out', 'TimeoutError')),
    );
    await approve(h);

    await expect(adminComplete(h)).rejects.toBeInstanceOf(ConflictException);
    await expect(adminComplete(h)).rejects.toBeInstanceOf(ConflictException);

    expectHeld(h);
    expect(h.adminAudit.record).toHaveBeenCalledTimes(2);
    refused(h);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['still pending', payout('pending')],
    ['unreadable', text(200, 'not json')],
    ['HTTP 500', json(500, {})],
    ['a network error', throws(new TypeError('fetch failed'))],
    ['"completed" for a different payout', payout('completed', 'pyt-other')],
  ])('refuses when the status check is %s', async (_name, check) => {
    const h = build();
    stubFetch(payout('pending'), check);
    await approve(h);

    await expect(adminComplete(h)).rejects.toBeInstanceOf(ConflictException);
    expectHeld(h);
    refused(h);
  });

  it('refuses, and says to fail instead, when the provider reports the payout failed', async () => {
    const h = build();
    stubFetch(payout('pending'), payout('failed'));
    await approve(h);

    await expect(adminComplete(h)).rejects.toThrow(/failed/i);
    expectHeld(h);
  });

  it('completes once when the provider confirms the payout, and a late failure event releases nothing', async () => {
    const h = build();
    const fetchSpy = stubFetch(payout('pending'), payout('completed'));
    await approve(h);

    await adminComplete(h);

    expectPaidOnce(h);
    expect(submissions(h)[0].status).toBe('SUCCEEDED');
    expect(
      h.db.operations.filter((o) => o.kind === 'PAYOUT_STATUS_CHECK'),
    ).toEqual([
      expect.objectContaining({
        status: 'SUCCEEDED',
        requestSnapshot: expect.objectContaining({ adminId: 'admin-1' }),
      }),
    ]);
    expect(posts(fetchSpy)).toHaveLength(1);

    await expect(adminComplete(h)).rejects.toBeInstanceOf(ConflictException);
    await h.deliver('evt-late', 'payout.failed', 'pyt-1');
    await h.deliver('evt-late-2', 'payout.completed', 'pyt-1');
    expectPaidOnce(h);
  });

  it('completes from a recorded provider success without asking again', async () => {
    const h = build();
    const fetchSpy = stubFetch();
    // The provider answered "completed" but the process stopped before the
    // withdrawal was finalised.
    h.db.withdrawal.status = 'PROCESSING';
    h.db.withdrawal.providerReference = 'pyt-1';
    h.db.operations.push({
      id: 'op-1',
      kind: 'PAYOUT_SUBMIT',
      status: 'SUCCEEDED',
      provider: 'MONIME',
      relatedWithdrawalId: 'wd-1',
      providerIdempotencyKey: 'original-key',
    });

    await adminComplete(h);

    expectPaidOnce(h);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a manual completion with no payout request still works, once', async () => {
    const h = build();
    h.db.withdrawal.destinationDetails = { method: 'UNSUPPORTED' } as never;
    const fetchSpy = stubFetch();
    await approve(h);

    await adminComplete(h);

    expectPaidOnce(h);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.adminAudit.record).not.toHaveBeenCalled();
  });

  it('two concurrent manual completions debit once', async () => {
    const h = build();
    h.db.withdrawal.status = 'APPROVED';
    stubFetch();

    const results = await Promise.allSettled([
      adminComplete(h, 'admin-1'),
      adminComplete(h, 'admin-2'),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expectPaidOnce(h);
  });

  it('a completion racing a submission never both debits and sends a payout', async () => {
    const h = build();
    h.db.withdrawal.status = 'APPROVED';
    const fetchSpy = stubFetch(payout('pending'));

    const [submitted, completed] = await Promise.allSettled([
      h.service.submitPayout('wd-1'),
      adminComplete(h),
    ]);

    expect(submitted.status).toBe('fulfilled');
    if (completed.status === 'fulfilled') {
      expectPaidOnce(h);
      expect(posts(fetchSpy)).toHaveLength(0);
      expect(submissions(h)).toHaveLength(0);
    } else {
      expect(completed.reason).toBeInstanceOf(ConflictException);
      expectHeld(h);
      expect(posts(fetchSpy)).toHaveLength(1);
    }
  });
});
