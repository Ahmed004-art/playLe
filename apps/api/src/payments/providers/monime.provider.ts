import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../../config/configuration.js';
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
  ProviderOperationOutcome,
  WebhookDepositPayload,
  WebhookPayoutPayload,
  WebhookVerificationResult,
} from '../ports/payment-provider.port.js';

/** The largest minor-unit amount that round-trips exactly through a JSON number. */
const MAX_SAFE_MINOR_VALUE = BigInt(Number.MAX_SAFE_INTEGER);

type MonimeDestination =
  | { type: 'momo'; providerId: 'm17' | 'm18'; phoneNumber: string }
  | {
      type: 'bank';
      providerId: 'slb001' | 'slb004' | 'slb007';
      accountNumber: string;
    }
  | { type: 'wallet'; providerId: 'dw001'; walletId?: string };

type MonimeRequestResult =
  | { kind: 'ok'; json: Record<string, unknown> | null }
  | { kind: 'http_error'; status: number; json: Record<string, unknown> | null }
  | { kind: 'network_error'; message: string };

type Readiness =
  | { ready: true; apiKey: string; spaceId: string }
  | { ready: false; reason: string };

/**
 * The real Monime integration boundary — built against the verified
 * `caph-2025-08-23` API (fetched directly from `docs.monime.io` and the
 * official `monimesl/monime-developer-apis` OpenAPI spec on 2026-10-11/12
 * — see docs/development/PHASE_6_CHECKLIST.md for the exact facts and
 * their sources). Deposits use Payment Codes (USSD/MoMo, no redirect —
 * the right fit for a native mobile app); payouts use the Payouts API.
 *
 * One fact remains genuinely unverifiable from any reachable source: the
 * exact byte string Monime's `Monime-Signature` HMAC-SHA256 covers.
 * `verifyWebhookSignature` therefore still **always returns invalid** —
 * extending, never weakening, the fail-closed stance Phase 3 shipped.
 * Everything else here (outbound calls, response parsing, webhook
 * *payload* parsing) is real and ready the moment that one fact is
 * confirmed (see the owner action in the checklist).
 */
@Injectable()
export class MonimeProvider implements PaymentProviderPort {
  readonly name = 'MONIME';
  private readonly logger = new Logger(MonimeProvider.name);

  constructor(
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  private get config() {
    return this.configService.get('payments', { infer: true });
  }

  async initiateDeposit(
    params: InitiateDepositParams,
  ): Promise<InitiateDepositResult> {
    const readiness = this.readiness();
    if (!readiness.ready) {
      this.logger.warn(
        `Deposit ${params.depositId} left PENDING without a provider call: ${readiness.reason}. See docs/development/PHASE_6_CHECKLIST.md.`,
      );
      return { providerReference: null, status: 'UNAVAILABLE' };
    }

    const amountValue = this.toMinorValue(params.amountMinor);
    if (amountValue === null) {
      this.logger.error(
        `Deposit ${params.depositId} amount exceeds what Monime's JSON integer amount field can safely represent.`,
      );
      return { providerReference: null, status: 'UNAVAILABLE' };
    }

    const result = await this.request(
      'POST',
      '/v1/payment-codes',
      readiness,
      {
        name: `PlayLe deposit ${params.depositId}`.slice(0, 64),
        amount: { currency: params.currency, value: amountValue },
        reference: params.depositId,
        // Only `m17` (Orange Money SL) is a provider id the official
        // spec documents a real description for — see checklist §0.
        authorizedProviders: ['m17'],
        metadata: { depositId: params.depositId, userId: params.userId },
      },
      params.providerIdempotencyKey,
    );

    if (result.kind === 'network_error') {
      // Ambiguous: a payment code may or may not have been created on
      // Monime's side. Low financial risk either way (nothing is ever
      // credited without a later *verified* webhook) — thrown so the
      // caller (`DepositsService.create`) records the attempt as
      // UNKNOWN for audit and leaves the deposit PENDING for retry.
      throw new Error(
        `Monime payment-code creation network error: ${result.message}`,
      );
    }

    if (result.kind === 'http_error') {
      this.logger.warn(
        `Deposit ${params.depositId} payment-code creation rejected by Monime (HTTP ${result.status}).`,
      );
      return {
        providerReference: null,
        status: 'UNAVAILABLE',
        raw: result.json,
      };
    }

    const pc = (result.json?.result ?? null) as Record<string, unknown> | null;
    const id = pc?.id;
    const ussdCode = pc?.ussdCode;
    const expireTime = pc?.expireTime;

    return {
      providerReference: typeof id === 'string' ? id : null,
      status: 'PENDING',
      userFacingInstructions: {
        ussdCode: typeof ussdCode === 'string' ? ussdCode : undefined,
        expiresAt: typeof expireTime === 'string' ? expireTime : undefined,
      },
      raw: result.json,
    };
  }

  async checkDepositStatus(
    params: CheckDepositStatusParams,
  ): Promise<CheckDepositStatusResult> {
    const readiness = this.readiness();
    if (!readiness.ready) return { outcome: 'UNKNOWN' };

    const result = await this.request(
      'GET',
      `/v1/payment-codes/${encodeURIComponent(params.providerReference)}`,
      readiness,
    );
    if (result.kind === 'network_error') return { outcome: 'UNKNOWN' };
    if (result.kind === 'http_error') {
      return { outcome: 'UNKNOWN', failureReason: `HTTP ${result.status}` };
    }

    const pc = (result.json?.result ?? null) as Record<string, unknown> | null;
    return { outcome: this.mapPaymentCodeStatus(pc?.status), raw: result.json };
  }

  async initiatePayout(
    params: InitiatePayoutParams,
  ): Promise<InitiatePayoutResult> {
    const readiness = this.readiness();
    if (!readiness.ready) {
      this.logger.warn(
        `Payout for withdrawal ${params.withdrawalId} not submitted: ${readiness.reason}. See docs/development/PHASE_6_CHECKLIST.md.`,
      );
      return { providerReference: null, outcome: 'UNAVAILABLE' };
    }

    const destination = this.toMonimeDestination(params.destinationDetails);
    if (!destination) {
      this.logger.error(
        `Payout for withdrawal ${params.withdrawalId} has a destination that does not map to a verified Monime destination — see docs/development/PHASE_6_CHECKLIST.md item 3.`,
      );
      return {
        providerReference: null,
        outcome: 'UNAVAILABLE',
        failureReason: 'Unsupported or unverified payout destination',
      };
    }

    const amountValue = this.toMinorValue(params.amountMinor);
    if (amountValue === null) {
      return {
        providerReference: null,
        outcome: 'UNAVAILABLE',
        failureReason: 'Amount exceeds the safely representable range',
      };
    }

    const result = await this.request(
      'POST',
      '/v1/payouts',
      readiness,
      {
        amount: { currency: params.currency, value: amountValue },
        destination,
        metadata: { withdrawalId: params.withdrawalId, userId: params.userId },
      },
      params.providerIdempotencyKey,
    );

    if (result.kind === 'network_error') {
      // Genuinely unknown whether the payout was created — never retried
      // with a new idempotency key (see ADR-019). Thrown so
      // `WithdrawalsService.submitPayout` records this exact attempt as
      // UNKNOWN and moves the withdrawal to PROCESSING pending
      // reconciliation, not a fresh submission.
      throw new Error(
        `Monime payout submission network error: ${result.message}`,
      );
    }

    if (result.kind === 'http_error') {
      return {
        providerReference: null,
        outcome: 'FAILED',
        failureReason: `Monime rejected the payout (HTTP ${result.status})`,
        raw: result.json,
      };
    }

    const payout = (result.json?.result ?? null) as Record<
      string,
      unknown
    > | null;
    const id = payout?.id;
    return {
      providerReference: typeof id === 'string' ? id : null,
      outcome: this.mapPayoutStatus(payout?.status),
      raw: result.json,
    };
  }

  async checkPayoutStatus(
    params: CheckPayoutStatusParams,
  ): Promise<CheckPayoutStatusResult> {
    const readiness = this.readiness();
    if (!readiness.ready) return { outcome: 'UNKNOWN' };

    const result = await this.request(
      'GET',
      `/v1/payouts/${encodeURIComponent(params.providerReference)}`,
      readiness,
    );
    if (result.kind === 'network_error') return { outcome: 'UNKNOWN' };
    if (result.kind === 'http_error') {
      return { outcome: 'UNKNOWN', failureReason: `HTTP ${result.status}` };
    }

    const payout = (result.json?.result ?? null) as Record<
      string,
      unknown
    > | null;
    return { outcome: this.mapPayoutStatus(payout?.status), raw: result.json };
  }

  verifyWebhookSignature(
    rawBody: string,
    _headers: Record<string, string | string[] | undefined>,
  ): WebhookVerificationResult {
    // Fail closed: the HMAC-SHA256 *algorithm* is confirmed (via the
    // official OpenAPI schema's `verificationMethod.hmac256` field), but
    // the exact canonical string it signs is not verifiable against any
    // reachable source as of this implementation — see
    // docs/development/PHASE_6_CHECKLIST.md §0.1 for the owner action
    // that unblocks this. Every delivery is rejected until then, exactly
    // extending (never weakening) the stance MonimeProvider has shipped
    // with since Phase 3.
    this.logger.warn(
      'Rejected a Monime webhook: signature verification is not yet implemented ' +
        '(owner action pending — see docs/development/PHASE_6_CHECKLIST.md item 3).',
    );
    // Exercises the payload-parsing logic below even though its result
    // is discarded, so that logic is proven correct by the same request
    // that will, once verification is unblocked, actually use it — see
    // the dedicated unit tests for `parseMonimeWebhookPayload`.
    this.parseMonimeWebhookPayload(rawBody);
    return { valid: false };
  }

  /**
   * Parses a Monime webhook body into PlayLe's abstract deposit/payout
   * payload shape (`{ apiVersion, event: {id, name, timestamp}, object:
   * {id, type}, data: {...} }}` — verified from `docs.monime.io`'s
   * webhook guide). Pure and side-effect-free; never treated as
   * authenticated on its own — only `verifyWebhookSignature`'s return
   * value governs that, and it is fail-closed today. Exposed for unit
   * testing.
   */
  parseMonimeWebhookPayload(rawBody: string): {
    providerEventId: string;
    eventType: string;
    parsedPayload: WebhookDepositPayload | WebhookPayoutPayload | null;
  } | null {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (!body || typeof body !== 'object') return null;

    const event = (body as Record<string, unknown>).event;
    const object = (body as Record<string, unknown>).object;
    const data = (body as Record<string, unknown>).data;

    const eventId =
      event && typeof event === 'object'
        ? (event as Record<string, unknown>).id
        : undefined;
    const eventName =
      event && typeof event === 'object'
        ? (event as Record<string, unknown>).name
        : undefined;
    const objectId =
      object && typeof object === 'object'
        ? (object as Record<string, unknown>).id
        : undefined;

    if (
      typeof eventId !== 'string' ||
      typeof eventName !== 'string' ||
      typeof objectId !== 'string'
    ) {
      return null;
    }

    return {
      providerEventId: eventId,
      eventType: eventName,
      parsedPayload: this.mapEventName(
        eventName,
        objectId,
        data && typeof data === 'object'
          ? (data as Record<string, unknown>)
          : undefined,
      ),
    };
  }

  private mapEventName(
    eventName: string,
    providerReference: string,
    data: Record<string, unknown> | undefined,
  ): WebhookDepositPayload | WebhookPayoutPayload | null {
    switch (eventName) {
      case 'payment_code.completed': {
        // Fail closed: a completion is only ever mapped to a deposit credit
        // when the event carries evidence of what was actually PAID. Without
        // it (or with it malformed) the payload is null, the event is stored
        // as IGNORED and shows up as an ORPHAN_PROVIDER_EVENT - it never
        // completes a deposit.
        const paid = this.readPaidAmount(data);
        if (!paid) return null;
        return {
          eventType: 'deposit.completed',
          providerReference,
          amountMinor: paid.amountMinor,
          currency: paid.currency,
        };
      }
      case 'payment_code.expired':
        return { eventType: 'deposit.expired', providerReference };
      case 'payout.completed':
        return { eventType: 'payout.completed', providerReference };
      case 'payout.failed': {
        const failureDetail = data?.failureDetail as
          Record<string, unknown> | undefined;
        const reason = failureDetail?.message;
        return {
          eventType: 'payout.failed',
          providerReference,
          reason: typeof reason === 'string' ? reason : undefined,
        };
      }
      case 'payout.delayed':
        return { eventType: 'payout.processing', providerReference };
      default:
        return null;
    }
  }

  /**
   * The amount actually PAID against a payment code, from
   * `data.progress.totalPaymentSum` (`{ currency, value }`, `value` an
   * integer in the currency's minor unit), or `null` if it is absent or
   * malformed.
   *
   * PROVISIONAL / UNVERIFIED: this field path is taken from Monime's public
   * documentation (the webhook "Structure and Events" page, whose `data` is the
   * REST Payment Code object), not from a captured delivery - the docs are
   * internally inconsistent (sample payloads are `apiVersion 2024-08-01`, the
   * object pages `caph-2025-08-23`, and they name the processed-payment field
   * differently) and say nothing about partial or over-payments. It must be
   * re-checked against a real Test-mode `payment_code.completed` delivery
   * before this integration is considered production-ready.
   *
   * Deliberately NOT read: `data.amount`, the payment code's CONFIGURED amount.
   * It says what was asked for, not what was paid, so it is never used as a
   * substitute - a completion without a paid total is not trusted.
   */
  private readPaidAmount(
    data: Record<string, unknown> | undefined,
  ): { amountMinor: string; currency: string } | null {
    const progress = data?.progress;
    if (!progress || typeof progress !== 'object') return null;
    const sum = (progress as Record<string, unknown>).totalPaymentSum;
    if (!sum || typeof sum !== 'object') return null;
    const { currency, value } = sum as Record<string, unknown>;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      return null;
    }
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      return null;
    }
    return { amountMinor: String(value), currency };
  }

  private mapPaymentCodeStatus(status: unknown): ProviderOperationOutcome {
    switch (status) {
      case 'completed':
        return 'SUCCEEDED';
      case 'cancelled':
        return 'FAILED';
      case 'expired':
        return 'EXPIRED';
      case 'pending':
      case 'processing':
        return 'PENDING';
      default:
        return 'UNKNOWN';
    }
  }

  private mapPayoutStatus(status: unknown): ProviderOperationOutcome {
    switch (status) {
      case 'completed':
        return 'SUCCEEDED';
      case 'failed':
        return 'FAILED';
      case 'pending':
      case 'processing':
        return 'PENDING';
      default:
        return 'UNKNOWN';
    }
  }

  /**
   * Maps PlayLe's abstracted `Withdrawal.destinationDetails` to a real
   * Monime payout destination. Accepts either the exact Monime shape
   * directly, or the one legacy mapping documented as verified —
   * `ORANGE_MONEY` → `m17` (the only provider id the official spec gives
   * a real description for: "Orange Money SL"). Every other method
   * string is deliberately left unmapped rather than guessed (see
   * docs/development/PHASE_6_CHECKLIST.md item 3) — returns `null`,
   * which the caller treats as `UNAVAILABLE`, never a fabricated code.
   */
  private toMonimeDestination(
    details: Record<string, unknown>,
  ): MonimeDestination | null {
    if (
      details.type === 'momo' &&
      (details.providerId === 'm17' || details.providerId === 'm18') &&
      typeof details.phoneNumber === 'string'
    ) {
      return {
        type: 'momo',
        providerId: details.providerId,
        phoneNumber: details.phoneNumber,
      };
    }
    if (
      details.type === 'bank' &&
      (details.providerId === 'slb001' ||
        details.providerId === 'slb004' ||
        details.providerId === 'slb007') &&
      typeof details.accountNumber === 'string'
    ) {
      return {
        type: 'bank',
        providerId: details.providerId,
        accountNumber: details.accountNumber,
      };
    }
    if (details.type === 'wallet' && details.providerId === 'dw001') {
      return {
        type: 'wallet',
        providerId: 'dw001',
        walletId:
          typeof details.walletId === 'string' ? details.walletId : undefined,
      };
    }
    if (
      details.method === 'ORANGE_MONEY' &&
      typeof details.phoneNumber === 'string'
    ) {
      return {
        type: 'momo',
        providerId: 'm17',
        phoneNumber: details.phoneNumber,
      };
    }
    return null;
  }

  private toMinorValue(amountMinor: bigint): number | null {
    if (amountMinor < 0n || amountMinor > MAX_SAFE_MINOR_VALUE) return null;
    return Number(amountMinor);
  }

  /**
   * Whether a real HTTP call is currently allowed. Separate from
   * `provider === 'monime'` being selected at all: a *live* (non-
   * `mon_test_`) token additionally requires
   * `MONIME_LIVE_PAYMENTS_ENABLED=true` — see "production activation
   * guardrails" in docs/development/PHASE_6_CHECKLIST.md. A test token
   * always runs once the Space id is present.
   */
  private readiness(): Readiness {
    const { monimeApiKey, monimeSpaceId, monimeLivePaymentsEnabled } =
      this.config;

    if (!monimeApiKey)
      return { ready: false, reason: 'MONIME_API_KEY is not set' };
    if (!monimeSpaceId) {
      return { ready: false, reason: 'MONIME_SPACE_ID is not set' };
    }

    const isTestToken = monimeApiKey.startsWith('mon_test_');
    const isLiveToken = !isTestToken && monimeApiKey.startsWith('mon_');
    if (!isTestToken && !isLiveToken) {
      return {
        ready: false,
        reason:
          'MONIME_API_KEY does not match a recognized mon_/mon_test_ token format',
      };
    }
    if (isLiveToken && !monimeLivePaymentsEnabled) {
      return {
        ready: false,
        reason:
          'a live Monime token is configured but MONIME_LIVE_PAYMENTS_ENABLED is not true',
      };
    }

    return { ready: true, apiKey: monimeApiKey, spaceId: monimeSpaceId };
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    readiness: { ready: true; apiKey: string; spaceId: string },
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<MonimeRequestResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${readiness.apiKey}`,
      'Monime-Space-Id': readiness.spaceId,
      'Content-Type': 'application/json',
    };
    if (this.config.monimeApiVersion) {
      headers['Monime-Version'] = this.config.monimeApiVersion;
    }
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    try {
      const response = await fetch(`${this.config.monimeBaseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.config.monimeHttpTimeoutMs),
      });

      const json = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;

      if (!response.ok) {
        return { kind: 'http_error', status: response.status, json };
      }
      return { kind: 'ok', json };
    } catch (error) {
      return {
        kind: 'network_error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
