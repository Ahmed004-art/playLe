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
      data: {},
    });

    expect(provider.parseMonimeWebhookPayload(body)).toEqual({
      providerEventId: 'evt-1',
      eventType: 'payment_code.completed',
      parsedPayload: {
        eventType: 'deposit.completed',
        providerReference: 'pc-1',
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
