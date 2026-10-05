/**
 * The boundary every external payment provider must implement. Nothing
 * outside `src/payments/` should ever reference a provider-specific
 * concept (Monime or otherwise) — `DepositsService`/`WithdrawalsService`
 * only ever talk to this interface. See
 * docs/decisions/ADR-013-payment-provider-abstraction.md.
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface InitiateDepositParams {
  depositId: string;
  userId: string;
  amountMinor: bigint;
  currency: string;
}

export interface InitiateDepositResult {
  /** A provider-side reference, if one was actually issued. */
  providerReference: string | null;
  /**
   * `PENDING` — the provider accepted the request and will confirm later
   * via a webhook/provider event. `UNAVAILABLE` — no real provider call
   * was made (e.g. Monime isn't configured/verified yet); the deposit
   * stays PENDING in PlayLe pending manual/future provider confirmation.
   */
  status: 'PENDING' | 'UNAVAILABLE';
}

export interface WebhookVerificationResult {
  valid: boolean;
  providerEventId?: string;
  eventType?: string;
  parsedPayload?: unknown;
}

/**
 * The shape `DepositsService.processProviderWebhook` expects inside
 * `WebhookVerificationResult.parsedPayload` once a provider's event
 * actually concerns a deposit. Not every provider event needs to match
 * this — unrecognized payloads are safely ignored (recorded in
 * `ProviderEvent`, no ledger effect). `providerReference` must be the
 * same value the provider was given back from `initiateDeposit`.
 */
export interface WebhookDepositPayload {
  eventType: 'deposit.completed' | 'deposit.failed';
  providerReference: string;
  reason?: string;
}

export interface PaymentProviderPort {
  readonly name: string;

  initiateDeposit(
    params: InitiateDepositParams,
  ): Promise<InitiateDepositResult>;

  /**
   * Verifies an inbound webhook's authenticity. Must fail closed — return
   * `{ valid: false }` rather than guess — whenever the provider's real
   * signature scheme cannot be verified against official documentation.
   */
  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookVerificationResult;
}
