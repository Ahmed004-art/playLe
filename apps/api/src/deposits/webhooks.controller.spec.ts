import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { WebhooksController } from './webhooks.controller.js';

/**
 * The webhook endpoint's response contract: an unauthenticated delivery is never
 * acknowledged (401, nothing processed) because nothing is stored for it and a
 * 2xx would stop the sender retrying; every authenticated delivery is answered
 * 200 whatever its business outcome, and is routed to exactly one service.
 */

type Verification = {
  valid: boolean;
  providerEventId?: string;
  eventType?: string;
  parsedPayload?: unknown;
};

function build(verification: Verification, serviceResult = 'processed') {
  const provider = { verifyWebhookSignature: vi.fn(() => verification) };
  const depositsService = {
    getProvider: vi.fn(() => provider),
    processProviderWebhook: vi.fn(() => Promise.resolve(serviceResult)),
  };
  const withdrawalsService = {
    processProviderWebhook: vi.fn(() => Promise.resolve(serviceResult)),
  };
  const controller = new WebhooksController(
    depositsService as never,
    withdrawalsService as never,
  );
  return { controller, provider, depositsService, withdrawalsService };
}

const request = (rawBody: Buffer | undefined, headers = {}) =>
  ({ rawBody, headers }) as never;

const depositEvent: Verification = {
  valid: true,
  providerEventId: 'evt-1',
  eventType: 'deposit.completed',
  parsedPayload: { eventType: 'deposit.completed', providerReference: 'ref-1' },
};
const payoutEvent: Verification = {
  valid: true,
  providerEventId: 'evt-2',
  eventType: 'payout.completed',
  parsedPayload: { eventType: 'payout.completed', providerReference: 'pyt-1' },
};

describe('WebhooksController', () => {
  it('rejects a delivery whose signature does not verify with 401 and processes nothing', async () => {
    const h = build({ valid: false });

    await expect(
      h.controller.handle(request(Buffer.from('{"a":1}'), { 'x-sig': 'bad' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(h.provider.verifyWebhookSignature).toHaveBeenCalledTimes(1);
    expect(h.depositsService.processProviderWebhook).not.toHaveBeenCalled();
    expect(h.withdrawalsService.processProviderWebhook).not.toHaveBeenCalled();
  });

  it('rejects a delivery with no raw body with 401, without trying to verify an empty body', async () => {
    const h = build(depositEvent);

    await expect(
      h.controller.handle(request(undefined)),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(h.provider.verifyWebhookSignature).not.toHaveBeenCalled();
    expect(h.depositsService.processProviderWebhook).not.toHaveBeenCalled();
  });

  it('passes the exact raw bytes (as UTF-8) and the headers to verification', async () => {
    const h = build(depositEvent);
    const raw = Buffer.from('{ "spaced" :  "json" }\n', 'utf-8');
    const headers = { 'monime-signature': 'x' };

    await h.controller.handle(request(raw, headers));

    expect(h.provider.verifyWebhookSignature).toHaveBeenCalledWith(
      '{ "spaced" :  "json" }\n',
      headers,
    );
  });

  it('routes an authenticated deposit event to the deposits service only, answering its status', async () => {
    const h = build(depositEvent);

    expect(await h.controller.handle(request(Buffer.from('{}')))).toEqual({
      status: 'processed',
    });
    expect(h.depositsService.processProviderWebhook).toHaveBeenCalledTimes(1);
    expect(h.withdrawalsService.processProviderWebhook).not.toHaveBeenCalled();
  });

  it('routes an authenticated payout event to the withdrawals service only', async () => {
    const h = build(payoutEvent);

    await h.controller.handle(request(Buffer.from('{}')));

    expect(h.withdrawalsService.processProviderWebhook).toHaveBeenCalledTimes(
      1,
    );
    expect(h.depositsService.processProviderWebhook).not.toHaveBeenCalled();
  });

  it.each(['ignored', 'rejected'])(
    'answers an authenticated %s delivery normally (200 via @HttpCode), not as an error',
    async (outcome) => {
      // 'ignored' = a duplicate or unmatched event; 'rejected' = an authenticated
      // event refused on business grounds (e.g. amount mismatch) and recorded.
      const h = build(depositEvent, outcome);

      expect(await h.controller.handle(request(Buffer.from('{}')))).toEqual({
        status: outcome,
      });
    },
  );
});
