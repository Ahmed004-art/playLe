import { describe, expect, it } from 'vitest';
import { ManualProvider } from './manual.provider.js';

describe('ManualProvider', () => {
  it('issues a PENDING internal reference without any network call', async () => {
    const provider = new ManualProvider();

    const result = await provider.initiateDeposit({
      depositId: 'd1',
      userId: 'u1',
      amountMinor: 1000n,
      currency: 'SLE',
    });

    expect(result.status).toBe('PENDING');
    expect(result.providerReference).toMatch(/^manual_/);
  });

  it('never verifies a webhook signature as valid', () => {
    const provider = new ManualProvider();
    expect(provider.verifyWebhookSignature().valid).toBe(false);
  });
});
