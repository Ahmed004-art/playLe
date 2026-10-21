import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { DepositsService } from './deposits.service.js';

/**
 * `processProviderWebhook` for a verified `deposit.completed` event whose
 * reported amount / currency must agree with the deposit it is applied to.
 *
 * Contract under test (the provider-neutral payload, see
 * `WebhookDepositPayload`): a provider that reports what was paid puts
 * `amountMinor` (a canonical non-negative decimal integer *string* of minor
 * units - never a JS number, which cannot represent every amount safely and is
 * not JSON-safe as a BigInt) and `currency` (3-letter ISO code) on the parsed
 * payload. Both present or both absent. When present they must equal the
 * deposit's stored amount and currency; otherwise the event is recorded as
 * REJECTED and the deposit is left untouched (PENDING): not claimed, no ledger
 * credit, no notification. A provider that reports neither keeps today's
 * behaviour. The database is replaced by fakes; the real behaviour against
 * Postgres is `test/wallet.e2e-spec.ts` (CI only).
 */

const pending = {
  id: 'deposit-1',
  userId: 'user-1',
  amountMinor: 4000n,
  currency: 'SLE',
  status: 'PENDING',
  providerReference: 'pmc-1',
};

type Extras = Record<string, unknown>;

function build(
  eventExtras: Extras,
  claimCounts: number[] = [1],
  /** Deliver every event under this one provider event id (a replay). */
  fixedEventId?: string,
) {
  const claims = [...claimCounts];
  // Models the unique (provider, providerEventId) index: a second create for
  // an id already stored fails with P2002, exactly as Postgres does.
  const seenEventIds = new Set<string>();
  const tx = {
    deposit: {
      updateMany: vi.fn(() => Promise.resolve({ count: claims.shift() ?? 0 })),
      findUniqueOrThrow: vi.fn(() =>
        Promise.resolve({ ...pending, status: 'COMPLETED' }),
      ),
    },
  };
  const prisma = {
    providerEvent: {
      create: vi.fn((args: { data: { providerEventId: string } }) => {
        if (seenEventIds.has(args.data.providerEventId)) {
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError('Unique constraint', {
              code: 'P2002',
              clientVersion: 'test',
            }),
          );
        }
        seenEventIds.add(args.data.providerEventId);
        return Promise.resolve({ id: 'pe-1' });
      }),
      update: vi.fn(() => Promise.resolve({})),
    },
    deposit: {
      findFirst: vi.fn(() => Promise.resolve({ ...pending })),
      findUnique: vi.fn(() => Promise.resolve({ ...pending })),
    },
    $transaction: vi.fn((fn: (c: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  let eventSeq = 0;
  const provider = {
    name: 'FAKE',
    verifyWebhookSignature: vi.fn(() => ({
      valid: true,
      providerEventId: fixedEventId ?? `evt-${++eventSeq}`,
      eventType: 'deposit.completed',
      parsedPayload: {
        eventType: 'deposit.completed',
        providerReference: 'pmc-1',
        ...eventExtras,
      },
    })),
  };
  const ledgerService = { applyEntry: vi.fn(() => Promise.resolve({})) };
  const walletService = {
    getWalletIdForUser: vi.fn(() => Promise.resolve('wallet-1')),
  };
  const notificationOutbox = { enqueue: vi.fn(() => Promise.resolve()) };
  const service = new DepositsService(
    prisma as never,
    ledgerService as never,
    walletService as never,
    {} as never,
    provider as never,
    {} as never,
    notificationOutbox as never,
  );
  return { service, prisma, tx, ledgerService, notificationOutbox };
}

/** The deposit was neither claimed nor credited nor announced. */
function expectUntouched(h: ReturnType<typeof build>): void {
  expect(h.prisma.$transaction).not.toHaveBeenCalled();
  expect(h.tx.deposit.updateMany).not.toHaveBeenCalled();
  expect(h.ledgerService.applyEntry).not.toHaveBeenCalled();
  expect(h.notificationOutbox.enqueue).not.toHaveBeenCalled();
}

describe('processProviderWebhook - deposit.completed amount/currency', () => {
  describe('a matching event', () => {
    it('credits exactly once and records the event PROCESSED', async () => {
      const h = build({ amountMinor: '4000', currency: 'SLE' });

      expect(await h.service.processProviderWebhook('{}', {})).toBe(
        'processed',
      );

      expect(h.tx.deposit.updateMany).toHaveBeenCalledTimes(1);
      expect(h.ledgerService.applyEntry).toHaveBeenCalledTimes(1);
      expect(h.ledgerService.applyEntry).toHaveBeenCalledWith(
        h.tx,
        'wallet-1',
        expect.objectContaining({
          type: 'DEPOSIT',
          availableDeltaMinor: 4000n,
          currency: 'SLE',
        }),
      );
      expect(h.notificationOutbox.enqueue).toHaveBeenCalledTimes(1);
      expect(h.prisma.providerEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PROCESSED' }),
        }),
      );
    });

    it('credits once even when a second matching event arrives (the claim is lost)', async () => {
      // The claim count models the database: first event wins the row, the
      // second finds it already COMPLETED.
      const h = build({ amountMinor: '4000', currency: 'SLE' }, [1, 0]);

      await h.service.processProviderWebhook('{}', {});
      await h.service.processProviderWebhook('{}', {});

      expect(h.ledgerService.applyEntry).toHaveBeenCalledTimes(1);
      expect(h.notificationOutbox.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  describe('a provider that reports neither amount nor currency', () => {
    it('keeps its current behaviour: credits the deposit once', async () => {
      const h = build({});

      expect(await h.service.processProviderWebhook('{}', {})).toBe(
        'processed',
      );

      expect(h.ledgerService.applyEntry).toHaveBeenCalledTimes(1);
    });
  });

  describe('a mismatching event cannot credit or claim the deposit', () => {
    const cases: [string, Extras][] = [
      [
        'amount below the expected amount',
        { amountMinor: '1', currency: 'SLE' },
      ],
      [
        'amount just below the expected amount',
        { amountMinor: '3999', currency: 'SLE' },
      ],
      [
        'amount above the expected amount',
        { amountMinor: '4001', currency: 'SLE' },
      ],
      [
        'amount far above the expected amount',
        { amountMinor: '400000', currency: 'SLE' },
      ],
      ['zero amount', { amountMinor: '0', currency: 'SLE' }],
      ['currency mismatch', { amountMinor: '4000', currency: 'USD' }],
      [
        'amount and currency both wrong',
        { amountMinor: '100', currency: 'USD' },
      ],
    ];

    it.each(cases)('%s', async (_name, extras) => {
      const h = build(extras);

      expect(await h.service.processProviderWebhook('{}', {})).toBe('rejected');

      expectUntouched(h);
      // Recorded for audit as REJECTED - never PROCESSED.
      expect(h.prisma.providerEvent.update).toHaveBeenCalledTimes(1);
      expect(h.prisma.providerEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'REJECTED',
            relatedDepositId: 'deposit-1',
          }),
        }),
      );
    });
  });

  describe('a malformed amount or currency is never accepted', () => {
    // Strings must be canonical non-negative decimal integers. Numbers are not
    // accepted as `amountMinor` at all: a JS number cannot represent every
    // minor-unit amount, so a number here is a contract violation, however
    // "safe" it looks (4000.5 and 2**53 are the cases that make it dangerous).
    const malformed: [string, Extras][] = [
      ['fractional string', { amountMinor: '40.5', currency: 'SLE' }],
      ['negative string', { amountMinor: '-4000', currency: 'SLE' }],
      ['trailing garbage', { amountMinor: '4000abc', currency: 'SLE' }],
      ['exponent notation', { amountMinor: '4e3', currency: 'SLE' }],
      ['empty string', { amountMinor: '', currency: 'SLE' }],
      ['whitespace padding', { amountMinor: ' 4000 ', currency: 'SLE' }],
      ['plus sign', { amountMinor: '+4000', currency: 'SLE' }],
      ['fractional number', { amountMinor: 4000.5, currency: 'SLE' }],
      ['unsafe integer number', { amountMinor: 2 ** 53, currency: 'SLE' }],
      ['safe integer number', { amountMinor: 4000, currency: 'SLE' }],
      ['null amount', { amountMinor: null, currency: 'SLE' }],
      ['object amount', { amountMinor: { value: 4000 }, currency: 'SLE' }],
      ['bigint-sized string', { amountMinor: '9'.repeat(40), currency: 'SLE' }],
      ['empty currency', { amountMinor: '4000', currency: '' }],
      ['non-string currency', { amountMinor: '4000', currency: 706 }],
      ['lower-case currency', { amountMinor: '4000', currency: 'sle' }],
      ['amount without currency', { amountMinor: '4000' }],
      ['currency without amount', { currency: 'SLE' }],
    ];

    it.each(malformed)('%s', async (_name, extras) => {
      const h = build(extras);

      expect(await h.service.processProviderWebhook('{}', {})).toBe('rejected');

      expectUntouched(h);
      expect(h.prisma.providerEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'REJECTED',
            relatedDepositId: 'deposit-1',
          }),
        }),
      );
    });
  });

  it('does not let a rejected event consume the deposit: a later matching event still completes it', async () => {
    // Same service, two deliveries with different provider event ids.
    const h = build({ amountMinor: '1', currency: 'SLE' });
    expect(await h.service.processProviderWebhook('{}', {})).toBe('rejected');
    expectUntouched(h);

    // The provider now reports the right amount (e.g. after a correction).
    (
      h.service.getProvider().verifyWebhookSignature as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      valid: true,
      providerEventId: 'evt-later',
      eventType: 'deposit.completed',
      parsedPayload: {
        eventType: 'deposit.completed',
        providerReference: 'pmc-1',
        amountMinor: '4000',
        currency: 'SLE',
      },
    });

    expect(await h.service.processProviderWebhook('{}', {})).toBe('processed');
    expect(h.ledgerService.applyEntry).toHaveBeenCalledTimes(1);
  });

  describe('replaying the same provider event id', () => {
    it('a replayed REJECTED event is ignored: no second event row, no update, no credit, no notification', async () => {
      const h = build({ amountMinor: '1', currency: 'SLE' }, [1], 'evt-same');

      expect(await h.service.processProviderWebhook('{}', {})).toBe('rejected');
      const eventsStored = h.prisma.providerEvent.create.mock.calls.length;
      const eventUpdates = h.prisma.providerEvent.update.mock.calls.length;

      // The identical delivery again (same provider event id).
      expect(await h.service.processProviderWebhook('{}', {})).toBe('ignored');

      // The second attempt stopped at the unique index: it recorded and
      // changed nothing further.
      expect(h.prisma.providerEvent.create.mock.calls.length).toBe(
        eventsStored + 1,
      );
      expect(h.prisma.providerEvent.update.mock.calls.length).toBe(
        eventUpdates,
      );
      expectUntouched(h);
    });

    it('a replayed COMPLETED event credits exactly once, however many times it is delivered', async () => {
      const h = build(
        { amountMinor: '4000', currency: 'SLE' },
        [1, 0, 0],
        'evt-same',
      );

      expect(await h.service.processProviderWebhook('{}', {})).toBe(
        'processed',
      );
      expect(await h.service.processProviderWebhook('{}', {})).toBe('ignored');
      expect(await h.service.processProviderWebhook('{}', {})).toBe('ignored');

      expect(h.ledgerService.applyEntry).toHaveBeenCalledTimes(1);
      expect(h.notificationOutbox.enqueue).toHaveBeenCalledTimes(1);
      // Only the first delivery's event was ever updated.
      expect(h.prisma.providerEvent.update).toHaveBeenCalledTimes(1);
    });
  });

  it('applies the same validation only to completions: failed and expired events carry no amount requirement', async () => {
    const h = build({});
    (
      h.service.getProvider().verifyWebhookSignature as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      valid: true,
      providerEventId: 'evt-exp',
      eventType: 'deposit.expired',
      parsedPayload: {
        eventType: 'deposit.expired',
        providerReference: 'pmc-1',
      },
    });

    expect(await h.service.processProviderWebhook('{}', {})).toBe('processed');
    expect(h.ledgerService.applyEntry).not.toHaveBeenCalled();
  });
});
