import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { MonimeProvider } from './monime.provider.js';
import type { AppConfiguration } from '../../config/configuration.js';

function fakeConfigService(
  monimeApiKey?: string,
): ConfigService<AppConfiguration, true> {
  return { get: () => monimeApiKey } as unknown as ConfigService<
    AppConfiguration,
    true
  >;
}

describe('MonimeProvider', () => {
  it('never makes a real provider call when no API key is configured', async () => {
    const provider = new MonimeProvider(fakeConfigService(undefined));

    const result = await provider.initiateDeposit({
      depositId: 'd1',
      userId: 'u1',
      amountMinor: 1000n,
      currency: 'SLE',
    });

    expect(result).toEqual({ providerReference: null, status: 'UNAVAILABLE' });
  });

  it('still refuses to call Monime even when an API key is present, since the real API is unverified', async () => {
    const provider = new MonimeProvider(fakeConfigService('some-api-key'));

    const result = await provider.initiateDeposit({
      depositId: 'd1',
      userId: 'u1',
      amountMinor: 1000n,
      currency: 'SLE',
    });

    expect(result).toEqual({ providerReference: null, status: 'UNAVAILABLE' });
  });

  it('fails closed on webhook signature verification', () => {
    const provider = new MonimeProvider(fakeConfigService('some-api-key'));
    expect(provider.verifyWebhookSignature().valid).toBe(false);
  });
});
