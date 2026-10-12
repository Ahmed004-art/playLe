/**
 * The boundary every external payment provider must implement. Nothing
 * outside `src/payments/` should ever reference a provider-specific
 * concept (Monime or otherwise) — `DepositsService`/`WithdrawalsService`
 * only ever talk to this interface. See
 * docs/decisions/ADR-013-payment-provider-abstraction.md and
 * docs/decisions/ADR-019-production-payments.md (Phase 6 payout/status
 * additions).
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * A provider-call outcome that cannot be assumed successful or failed —
 * e.g. an HTTP timeout after the request may already have reached the
 * provider. Per ADR-019, an `UNKNOWN` outcome is never retried with a new
 * idempotency key; it is only resolved by querying the provider for the
 * status of this exact operation (`checkDepositStatus`/
 * `checkPayoutStatus`, reusing the same reference), or by reconciliation.
 */
export type ProviderOperationOutcome =
  | 'SUCCEEDED'
  | 'FAILED'
  | 'PENDING'
  | 'UNKNOWN'
  /** Deposit-only: a Payment Code expired unused. Payouts never reach this. */
  | 'EXPIRED';

export interface InitiateDepositParams {
  depositId: string;
  userId: string;
  amountMinor: bigint;
  currency: string;
  /**
   * Persisted by `DepositsService` before this call and reused on any
   * retry of the *same* PlayLe-side deposit attempt — never minted fresh
   * for a retry, so the provider's own idempotency guarantee can do its
   * job.
   */
  providerIdempotencyKey: string;
}

export interface InitiateDepositResult {
  /** A provider-side reference, if one was actually issued. */
  providerReference: string | null;
  /**
   * `PENDING` — the provider accepted the request and will confirm later
   * via a webhook/provider event. `UNAVAILABLE` — no real provider call
   * was made (e.g. Monime isn't configured/enabled yet); the deposit
   * stays PENDING in PlayLe pending manual/future provider confirmation.
   */
  status: 'PENDING' | 'UNAVAILABLE';
  /**
   * Opaque, provider-specific instructions safe to show the end user
   * (e.g. a USSD code to dial and when it expires). Never contains
   * secrets or raw provider credentials.
   */
  userFacingInstructions?: {
    ussdCode?: string;
    expiresAt?: string;
  };
  /** Full provider response, for `ProviderOperation.responseSnapshot` audit storage only — never returned to the client as-is. */
  raw?: unknown;
}

export interface CheckDepositStatusParams {
  depositId: string;
  providerReference: string;
}

export interface CheckDepositStatusResult {
  outcome: ProviderOperationOutcome;
  failureReason?: string;
  raw?: unknown;
}

export interface InitiatePayoutParams {
  withdrawalId: string;
  userId: string;
  amountMinor: bigint;
  currency: string;
  /** Abstracted payout destination — see `Withdrawal.destinationDetails`. */
  destinationDetails: Record<string, unknown>;
  /** Same persist-and-reuse-on-retry contract as `InitiateDepositParams.providerIdempotencyKey`. */
  providerIdempotencyKey: string;
}

export interface InitiatePayoutResult {
  providerReference: string | null;
  /**
   * `UNAVAILABLE` — no live call was made (provider inert/unconfigured);
   * the existing manual-admin completion flow applies unchanged. Any
   * other value means a real call was attempted.
   */
  outcome: ProviderOperationOutcome | 'UNAVAILABLE';
  failureReason?: string;
  raw?: unknown;
}

export interface CheckPayoutStatusParams {
  withdrawalId: string;
  providerReference: string;
}

export interface CheckPayoutStatusResult {
  outcome: ProviderOperationOutcome;
  failureReason?: string;
  raw?: unknown;
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
  eventType: 'deposit.completed' | 'deposit.failed' | 'deposit.expired';
  providerReference: string;
  reason?: string;
}

/**
 * The payout equivalent of `WebhookDepositPayload`, consumed by
 * `WithdrawalsService.processProviderWebhook`.
 */
export interface WebhookPayoutPayload {
  eventType: 'payout.completed' | 'payout.failed' | 'payout.processing';
  providerReference: string;
  reason?: string;
}

export interface PaymentProviderPort {
  readonly name: string;

  initiateDeposit(
    params: InitiateDepositParams,
  ): Promise<InitiateDepositResult>;

  /**
   * Polls the provider for a deposit's current status. Used by recovery/
   * reconciliation when a webhook may have been missed or delayed — never
   * the primary crediting path (that stays webhook-driven).
   */
  checkDepositStatus(
    params: CheckDepositStatusParams,
  ): Promise<CheckDepositStatusResult>;

  initiatePayout(params: InitiatePayoutParams): Promise<InitiatePayoutResult>;

  /**
   * Polls the provider for a payout's current status. This is the
   * documented recovery mechanism for an `UNKNOWN` payout outcome (e.g.
   * after an HTTP timeout) — see ADR-019. Never creates a new payout.
   */
  checkPayoutStatus(
    params: CheckPayoutStatusParams,
  ): Promise<CheckPayoutStatusResult>;

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
