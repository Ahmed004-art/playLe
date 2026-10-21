import { randomUUID } from 'node:crypto';
import type {
  CheckDepositStatusParams,
  CheckDepositStatusResult,
  CheckPayoutStatusParams,
  CheckPayoutStatusResult,
  InitiateDepositParams,
  InitiateDepositResult,
  InitiatePayoutParams,
  InitiatePayoutResult,
  PaymentProviderPort,
  WebhookDepositPayload,
  WebhookPayoutPayload,
  WebhookVerificationResult,
} from '../src/payments/ports/payment-provider.port.js';

export type FakeDepositScenario = 'pending' | 'network_error';
export type FakePayoutScenario =
  'pending' | 'succeeded' | 'failed' | 'unavailable' | 'network_error';

/**
 * A deterministic test double — never used in production, only bound in
 * place of the real `PAYMENT_PROVIDER` token in e2e tests (via
 * `overrideProvider`). It's what actually proves the webhook →
 * ProviderEvent → {Deposits,Withdrawals}Service.completeFromProviderEvent
 * → LedgerService.applyEntry path works end-to-end for both deposits and
 * payouts, since neither ManualProvider nor MonimeProvider can ever
 * produce a valid signature (see their fail-closed
 * `verifyWebhookSignature`).
 */
export class FakePaymentProvider implements PaymentProviderPort {
  readonly name = 'FAKE';
  private readonly validSecret = 'fake-test-secret';

  /** Test control: forces the next `initiateDeposit` call's behavior. */
  depositScenario: FakeDepositScenario = 'pending';
  /** Test control: forces the next `initiatePayout` call's behavior. */
  payoutScenario: FakePayoutScenario = 'pending';

  initiateDeposit(
    params: InitiateDepositParams,
  ): Promise<InitiateDepositResult> {
    if (this.depositScenario === 'network_error') {
      return Promise.reject(new Error('fake network error'));
    }
    return Promise.resolve({
      providerReference: `fake_${params.depositId}`,
      status: 'PENDING',
      userFacingInstructions: {
        ussdCode: '*123*456#',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
  }

  checkDepositStatus(
    _params: CheckDepositStatusParams,
  ): Promise<CheckDepositStatusResult> {
    return Promise.resolve({ outcome: 'PENDING' });
  }

  initiatePayout(params: InitiatePayoutParams): Promise<InitiatePayoutResult> {
    switch (this.payoutScenario) {
      case 'network_error':
        return Promise.reject(new Error('fake network error'));
      case 'unavailable':
        return Promise.resolve({
          providerReference: null,
          outcome: 'UNAVAILABLE',
        });
      case 'succeeded':
        return Promise.resolve({
          providerReference: `fake_payout_${params.withdrawalId}`,
          outcome: 'SUCCEEDED',
        });
      case 'failed':
        return Promise.resolve({
          providerReference: `fake_payout_${params.withdrawalId}`,
          outcome: 'FAILED',
          failureReason: 'fake provider rejected the payout',
        });
      case 'pending':
      default:
        return Promise.resolve({
          providerReference: `fake_payout_${params.withdrawalId}`,
          outcome: 'PENDING',
        });
    }
  }

  checkPayoutStatus(
    _params: CheckPayoutStatusParams,
  ): Promise<CheckPayoutStatusResult> {
    return Promise.resolve({ outcome: 'PENDING' });
  }

  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookVerificationResult {
    if (headers['x-fake-signature'] !== this.validSecret) {
      return { valid: false };
    }

    const payload = JSON.parse(rawBody) as (
      WebhookDepositPayload | WebhookPayoutPayload
    ) & {
      eventId: string;
      amountMinor?: unknown;
      currency?: unknown;
    };

    return {
      valid: true,
      providerEventId: payload.eventId,
      eventType: payload.eventType,
      parsedPayload: {
        eventType: payload.eventType,
        providerReference: payload.providerReference,
        reason: payload.reason,
        // Passed through only when the body carries them, exactly as given
        // (including wrong types), so a test can model a provider that
        // reports - or mis-reports - what was paid. Absent keys stay absent:
        // a provider that reports nothing keeps its legacy behaviour.
        ...('amountMinor' in payload
          ? { amountMinor: payload.amountMinor }
          : {}),
        ...('currency' in payload ? { currency: payload.currency } : {}),
      },
    };
  }

  /** Test helper: a valid signature header for `rawBody`. */
  signatureHeader(): string {
    return this.validSecret;
  }

  /** Test helper: builds a deposit webhook body referencing a given deposit's provider reference. */
  buildWebhookBody(params: {
    eventId?: string;
    eventType: 'deposit.completed' | 'deposit.failed' | 'deposit.expired';
    providerReference: string;
    reason?: string;
    /** What the provider reports as paid. Optional; sent verbatim (any type) to model mis-reporting. */
    amountMinor?: unknown;
    currency?: unknown;
  }): string {
    return JSON.stringify({ eventId: randomUUID(), ...params });
  }

  /** Test helper: builds a payout webhook body referencing a given withdrawal's provider reference. */
  buildPayoutWebhookBody(params: {
    eventId?: string;
    eventType: 'payout.completed' | 'payout.failed' | 'payout.processing';
    providerReference: string;
    reason?: string;
  }): string {
    return JSON.stringify({ eventId: randomUUID(), ...params });
  }
}
