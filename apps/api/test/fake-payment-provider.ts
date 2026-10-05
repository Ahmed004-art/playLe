import { randomUUID } from 'node:crypto';
import type {
  InitiateDepositParams,
  InitiateDepositResult,
  PaymentProviderPort,
  WebhookDepositPayload,
  WebhookVerificationResult,
} from '../src/payments/ports/payment-provider.port.js';

/**
 * A deterministic test double — never used in production, only bound in
 * place of the real `PAYMENT_PROVIDER` token in e2e tests (via
 * `overrideProvider`). It's what actually proves the webhook →
 * ProviderEvent → DepositsService.completeFromProviderEvent →
 * LedgerService.applyEntry path works end-to-end, since neither
 * ManualProvider nor MonimeProvider can ever produce a valid signature
 * (see their fail-closed `verifyWebhookSignature`).
 */
export class FakePaymentProvider implements PaymentProviderPort {
  readonly name = 'FAKE';
  private readonly validSecret = 'fake-test-secret';

  initiateDeposit(
    params: InitiateDepositParams,
  ): Promise<InitiateDepositResult> {
    return Promise.resolve({
      providerReference: `fake_${params.depositId}`,
      status: 'PENDING',
    });
  }

  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookVerificationResult {
    if (headers['x-fake-signature'] !== this.validSecret) {
      return { valid: false };
    }

    const payload = JSON.parse(rawBody) as WebhookDepositPayload & {
      eventId: string;
    };

    return {
      valid: true,
      providerEventId: payload.eventId,
      eventType: payload.eventType,
      parsedPayload: {
        eventType: payload.eventType,
        providerReference: payload.providerReference,
        reason: payload.reason,
      },
    };
  }

  /** Test helper: a valid signature header for `rawBody`. */
  signatureHeader(): string {
    return this.validSecret;
  }

  /** Test helper: builds a webhook body referencing a given deposit's provider reference. */
  buildWebhookBody(params: {
    eventId?: string;
    eventType: 'deposit.completed' | 'deposit.failed';
    providerReference: string;
    reason?: string;
  }): string {
    return JSON.stringify({ eventId: randomUUID(), ...params });
  }
}
