import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { MonimeProvider } from './monime.provider.js';
import type { AppConfiguration } from '../../config/configuration.js';

function fakeConfigService(
  overrides: Partial<AppConfiguration['payments']> = {},
): ConfigService<AppConfiguration, true> {
  const payments: AppConfiguration['payments'] = {
    provider: 'monime',
    monimeBaseUrl: 'https://api.monime.io',
    monimeHttpTimeoutMs: 5000,
    monimeLivePaymentsEnabled: false,
    minDepositMinor: 500n,
    minWithdrawalMinor: 500n,
    throttleLimit: 10,
    throttleTtlMs: 60000,
    ...overrides,
  };
  return {
    get: (key: string) => (key === 'payments' ? payments : undefined),
  } as unknown as ConfigService<AppConfiguration, true>;
}

describe('MonimeProvider — readiness / production activation guardrails', () => {
  it('never makes a real provider call when no API key is configured', async () => {
    const provider = new MonimeProvider(fakeConfigService());

    const result = await provider.initiateDeposit({
      depositId: 'd1',
      userId: 'u1',
      amountMinor: 1000n,
      currency: 'SLE',
      providerIdempotencyKey: 'key-1',
    });

    expect(result).toEqual({ providerReference: null, status: 'UNAVAILABLE' });
  });

  it('is unavailable when the API key is set but the Space id is missing', async () => {
    const provider = new MonimeProvider(
      fakeConfigService({ monimeApiKey: 'mon_test_abc' }),
    );

    const result = await provider.initiateDeposit({
      depositId: 'd1',
      userId: 'u1',
      amountMinor: 1000n,
      currency: 'SLE',
      providerIdempotencyKey: 'key-1',
    });

    expect(result).toEqual({ providerReference: null, status: 'UNAVAILABLE' });
  });

  it('rejects a token that does not match the mon_/mon_test_ format', async () => {
    const provider = new MonimeProvider(
      fakeConfigService({
        monimeApiKey: 'some-random-string',
        monimeSpaceId: 'spc-123',
      }),
    );

    const result = await provider.initiatePayout({
      withdrawalId: 'w1',
      userId: 'u1',
      amountMinor: 1000n,
      currency: 'SLE',
      destinationDetails: {
        method: 'ORANGE_MONEY',
        phoneNumber: '+23276000000',
      },
      providerIdempotencyKey: 'key-1',
    });

    expect(result.outcome).toBe('UNAVAILABLE');
  });

  it('refuses to call Monime with a live token unless MONIME_LIVE_PAYMENTS_ENABLED is true', async () => {
    const provider = new MonimeProvider(
      fakeConfigService({
        monimeApiKey: 'mon_live_realtoken',
        monimeSpaceId: 'spc-123',
        monimeLivePaymentsEnabled: false,
      }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await provider.initiateDeposit({
      depositId: 'd1',
      userId: 'u1',
      amountMinor: 1000n,
      currency: 'SLE',
      providerIdempotencyKey: 'key-1',
    });

    expect(result.status).toBe('UNAVAILABLE');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('allows a mon_test_ token to call out even without the live flag', async () => {
    const provider = new MonimeProvider(
      fakeConfigService({
        monimeApiKey: 'mon_test_abc',
        monimeSpaceId: 'spc-123',
        monimeLivePaymentsEnabled: false,
      }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            id: 'pc-1',
            ussdCode: '*123#',
            expireTime: '2026-01-01T00:00:00Z',
          },
        }),
        { status: 200 },
      ),
    );

    const result = await provider.initiateDeposit({
      depositId: 'd1',
      userId: 'u1',
      amountMinor: 1000n,
      currency: 'SLE',
      providerIdempotencyKey: 'key-1',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      providerReference: 'pc-1',
      status: 'PENDING',
      userFacingInstructions: {
        ussdCode: '*123#',
        expiresAt: '2026-01-01T00:00:00Z',
      },
      raw: expect.any(Object),
    });
    fetchSpy.mockRestore();
  });

  it('throws on a network error during initiateDeposit so the caller can record an UNKNOWN outcome', async () => {
    const provider = new MonimeProvider(
      fakeConfigService({
        monimeApiKey: 'mon_test_abc',
        monimeSpaceId: 'spc-123',
      }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('ECONNRESET'));

    await expect(
      provider.initiateDeposit({
        depositId: 'd1',
        userId: 'u1',
        amountMinor: 1000n,
        currency: 'SLE',
        providerIdempotencyKey: 'key-1',
      }),
    ).rejects.toThrow(/network error/);
    fetchSpy.mockRestore();
  });

  it('maps a rejected payout HTTP response to a definite FAILED outcome, never thrown', async () => {
    const provider = new MonimeProvider(
      fakeConfigService({
        monimeApiKey: 'mon_test_abc',
        monimeSpaceId: 'spc-123',
      }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 422 }));

    const result = await provider.initiatePayout({
      withdrawalId: 'w1',
      userId: 'u1',
      amountMinor: 1000n,
      currency: 'SLE',
      destinationDetails: {
        method: 'ORANGE_MONEY',
        phoneNumber: '+23276000000',
      },
      providerIdempotencyKey: 'key-1',
    });

    expect(result.outcome).toBe('FAILED');
    fetchSpy.mockRestore();
  });

  it('is unavailable for a payout destination that does not map to a verified Monime shape', async () => {
    const provider = new MonimeProvider(
      fakeConfigService({
        monimeApiKey: 'mon_test_abc',
        monimeSpaceId: 'spc-123',
      }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await provider.initiatePayout({
      withdrawalId: 'w1',
      userId: 'u1',
      amountMinor: 1000n,
      currency: 'SLE',
      destinationDetails: {
        method: 'AFRICELL_MONEY',
        phoneNumber: '+23276000000',
      },
      providerIdempotencyKey: 'key-1',
    });

    expect(result.outcome).toBe('UNAVAILABLE');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('fails closed on webhook signature verification regardless of configuration', () => {
    const provider = new MonimeProvider(
      fakeConfigService({
        monimeApiKey: 'mon_test_abc',
        monimeSpaceId: 'spc-123',
      }),
    );
    expect(provider.verifyWebhookSignature('{}', {}).valid).toBe(false);
  });
});

describe('MonimeProvider — webhook payload parsing (unverified-signature, logic-only)', () => {
  const provider = new MonimeProvider(fakeConfigService());

  it('parses a payment_code.completed event into the abstract deposit payload', () => {
    const body = JSON.stringify({
      apiVersion: 'caph-2025-08-23',
      event: {
        id: 'evt-1',
        name: 'payment_code.completed',
        timestamp: '2026-01-01T00:00:00Z',
      },
      object: { id: 'pc-1', type: 'payment_code' },
      // Evidence of what was paid is required for a completion to map to a
      // deposit (this fixture used to be `data: {}`, which encoded the gap that
      // any completion event was trusted). Field path PROVISIONAL - see the
      // "completed-payment amount" describe below.
      data: {
        progress: {
          totalPaymentSum: { currency: 'SLE', value: 1000 },
        },
      },
    });

    expect(provider.parseMonimeWebhookPayload(body)).toEqual({
      providerEventId: 'evt-1',
      eventType: 'payment_code.completed',
      parsedPayload: {
        eventType: 'deposit.completed',
        providerReference: 'pc-1',
        amountMinor: '1000',
        currency: 'SLE',
      },
    });
  });

  it('parses a payout.failed event, carrying the failure message through as the reason', () => {
    const body = JSON.stringify({
      apiVersion: 'caph-2025-08-23',
      event: {
        id: 'evt-2',
        name: 'payout.failed',
        timestamp: '2026-01-01T00:00:00Z',
      },
      object: { id: 'pyt-1', type: 'payout' },
      data: {
        failureDetail: {
          code: 'fund_insufficient',
          message: 'Insufficient funds',
        },
      },
    });

    expect(provider.parseMonimeWebhookPayload(body)).toEqual({
      providerEventId: 'evt-2',
      eventType: 'payout.failed',
      parsedPayload: {
        eventType: 'payout.failed',
        providerReference: 'pyt-1',
        reason: 'Insufficient funds',
      },
    });
  });

  it('returns null for an unrecognized event name', () => {
    const body = JSON.stringify({
      event: {
        id: 'evt-3',
        name: 'checkout_session.created',
        timestamp: '2026-01-01T00:00:00Z',
      },
      object: { id: 'cs-1', type: 'checkout_session' },
    });

    expect(provider.parseMonimeWebhookPayload(body)?.parsedPayload).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(provider.parseMonimeWebhookPayload('not json')).toBeNull();
  });
});

/**
 * PROVISIONAL. The field names and shapes below come from Monime's public
 * documentation (docs.monime.io: the webhook "Structure and Events" page,
 * whose `data` is "the same as the object structure in the Rest API", and the
 * Payment Code object), NOT from a real delivery - the exact completed-payment
 * payload has never been captured, and the docs disagree with themselves in
 * places (the sample payloads are `apiVersion 2024-08-01`; the object pages
 * are `caph-2025-08-23`, and name the processed-payment field differently).
 * Nothing here is a confirmed fact about Monime. These tests must be
 * re-checked against a captured Test-mode `payment_code.completed` delivery
 * before they are treated as final.
 *
 * What is documented and assumed:
 *  - `data.amount` is the payment code's CONFIGURED amount ("amount charged
 *    per use"), `{ currency, value }`, `value` an integer in the currency's
 *    minor unit (SLE 1 = 100).
 *  - `data.progress.totalPaymentSum` is the cumulative amount actually PAID
 *    against the code, same shape.
 * The configured amount and the paid amount are different facts and are not
 * interchangeable: the parser must report the PAID amount, and must not treat
 * the configured amount as evidence that anything was paid.
 */
describe('MonimeProvider - completed-payment amount (PROVISIONAL, unverified field names)', () => {
  const provider = new MonimeProvider(fakeConfigService());

  function completed(data: Record<string, unknown>): string {
    return JSON.stringify({
      apiVersion: '2024-08-01',
      event: { id: 'evt-amt', name: 'payment_code.completed', timestamp: 1 },
      object: { id: 'pmc-1', type: 'payment_code' },
      data,
    });
  }

  const sle = (value: unknown) => ({ currency: 'SLE', value });

  it('reports the PAID amount and currency, in minor units, as canonical strings', () => {
    const parsed = provider.parseMonimeWebhookPayload(
      completed({
        amount: sle(4000),
        progress: { isCompleted: true, totalPaymentSum: sle(4000) },
      }),
    );

    expect(parsed?.parsedPayload).toEqual({
      eventType: 'deposit.completed',
      providerReference: 'pmc-1',
      amountMinor: '4000',
      currency: 'SLE',
    });
  });

  it('reports what was paid, not what was configured, when they differ (partial payment)', () => {
    const parsed = provider.parseMonimeWebhookPayload(
      completed({
        amount: sle(4000),
        progress: { isCompleted: true, totalPaymentSum: sle(1000) },
      }),
    );

    // 1000, not 4000: the service then rejects it against the 4000 deposit.
    expect(parsed?.parsedPayload).toMatchObject({
      amountMinor: '1000',
      currency: 'SLE',
    });
  });

  it('reports an over-payment as paid, not as the configured amount', () => {
    const parsed = provider.parseMonimeWebhookPayload(
      completed({
        amount: sle(4000),
        progress: { isCompleted: true, totalPaymentSum: sle(8000) },
      }),
    );

    expect(parsed?.parsedPayload).toMatchObject({ amountMinor: '8000' });
  });

  it('reports the paid currency, not the configured one, when they differ', () => {
    const parsed = provider.parseMonimeWebhookPayload(
      completed({
        amount: sle(4000),
        progress: {
          isCompleted: true,
          totalPaymentSum: { currency: 'USD', value: 4000 },
        },
      }),
    );

    expect(parsed?.parsedPayload).toMatchObject({
      amountMinor: '4000',
      currency: 'USD',
    });
  });

  describe('is not trusted as a completed deposit (parsedPayload is null) when the paid amount is missing or malformed', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['empty data', {}],
      [
        'only the configured amount, no paid total',
        { amount: sle(4000), progress: { isCompleted: true } },
      ],
      ['no progress at all', { amount: sle(4000) }],
      [
        'fractional value',
        { amount: sle(4000), progress: { totalPaymentSum: sle(4000.5) } },
      ],
      [
        'unsafe-integer value',
        {
          amount: sle(4000),
          progress: { totalPaymentSum: sle(2 ** 53) },
        },
      ],
      [
        'negative value',
        { amount: sle(4000), progress: { totalPaymentSum: sle(-1) } },
      ],
      [
        'string value',
        { amount: sle(4000), progress: { totalPaymentSum: sle('4000') } },
      ],
      [
        'missing value',
        {
          amount: sle(4000),
          progress: { totalPaymentSum: { currency: 'SLE' } },
        },
      ],
      [
        'missing currency',
        { amount: sle(4000), progress: { totalPaymentSum: { value: 4000 } } },
      ],
      [
        'non-ISO currency',
        {
          amount: sle(4000),
          progress: { totalPaymentSum: { currency: 'sle', value: 4000 } },
        },
      ],
    ];

    it.each(cases)('%s', (_name, data) => {
      const parsed = provider.parseMonimeWebhookPayload(completed(data));

      // Still recorded as a recognised payment_code.completed event (so it is
      // visible to reconciliation) but never mapped to a credit.
      expect(parsed).not.toBeNull();
      expect(parsed?.eventType).toBe('payment_code.completed');
      expect(parsed?.parsedPayload).toBeNull();
    });
  });

  it('leaves non-completion events alone: an expired code needs no amount', () => {
    const body = JSON.stringify({
      event: { id: 'evt-exp', name: 'payment_code.expired', timestamp: 1 },
      object: { id: 'pmc-1', type: 'payment_code' },
      data: {},
    });

    expect(provider.parseMonimeWebhookPayload(body)?.parsedPayload).toEqual({
      eventType: 'deposit.expired',
      providerReference: 'pmc-1',
    });
  });
});
