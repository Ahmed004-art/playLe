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
import {
  MONIME_DEFAULT_API_VERSION,
  MONIME_PAYMENT_CODE_MODE,
  MONIME_SIGNATURE_HEADER,
} from './monime.constants.js';

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
 * The webhook signature procedure is not established by any public source:
 * which header carries it, its value format, the exact bytes it covers and its
 * encoding are all undocumented (the method is only known to be `HS256` or
 * `ES256`). `verifyWebhookSignature` therefore still **always returns
 * invalid** — extending, never weakening, the fail-closed stance Phase 3
 * shipped. Outbound calls and response parsing are implemented against the
 * documentation; the webhook *payload* parsing (event names, paid-amount
 * location) is provisional until a real Test-mode delivery is captured.
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
        // Single-use, explicitly: see MONIME_PAYMENT_CODE_MODE.
        mode: MONIME_PAYMENT_CODE_MODE,
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
    headers: Record<string, string | string[] | undefined>,
  ): WebhookVerificationResult {
    // Fail closed. Monime's public sources establish only that a webhook is
    // verified by `verificationMethod.type` `HS256` (an HMAC over a
    // caller-supplied secret, 32-256 characters) or `ES256` (ECDSA, P-256).
    // They do NOT establish the header the signature arrives in, its value
    // format, the exact bytes it covers, its encoding, or any timestamp
    // tolerance: the HMAC-verification guide is an empty placeholder and no
    // official SDK implements it. Guessing any of those would risk crediting a
    // wallet on a forgeable request, so every delivery is rejected until a
    // documented procedure or a verified test vector exists - see
    // docs/decisions/ADR-019-production-payments.md. This only ever extends
    // (never weakens) the stance MonimeProvider has shipped with since Phase 3.
    //
    // What a rejected delivery DOES tell an operator, safely: which header
    // NAMES arrived (the names are not secret; the values are never logged),
    // the body size, and the event the body claims to be. That is what is needed
    // to find the signature header on a real Test-mode delivery without
    // recording the signature itself.
    const parsed = this.parseMonimeWebhookPayload(rawBody);
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    const headerNames = [...names].sort().join(', ');
    // The header NAME is documented (docs.monime.io standard headers:
    // "Monime-Signature - Cryptographic signature with timestamp"); its value
    // format and the bytes it covers are not.
    const signatureHeaderPresent = names.includes(MONIME_SIGNATURE_HEADER);
    this.logger.warn(
      'Rejected a Monime webhook: signature verification is not implemented ' +
        '(fail-closed). ' +
        `Monime-Signature header present: ${signatureHeaderPresent}. ` +
        `Header names received: [${headerNames}]. ` +
        `Body bytes: ${Buffer.byteLength(rawBody, 'utf-8')}. ` +
        `Claimed event: ${parsed ? `${parsed.eventType} (${parsed.providerEventId})` : 'unparseable'}.`,
    );
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
    // Only the `payment_code.*` and `payout.*` names the documentation ties to
    // a payment code / payout are mapped. Two documented-but-ambiguous names are
    // deliberately NOT mapped, so they can never credit a wallet:
    //  - `payment.*` (e.g. `payment.completed`, named in the caph webhook pages):
    //    nothing says `object.id` is a payment CODE id, so it cannot be matched to
    //    a deposit's providerReference;
    //  - `payment_code.processed`: a payment was processed against the code, but
    //    nothing establishes it is final/settled the way `completed` is.
    // Both fall through to `null` (stored IGNORED, visible to reconciliation).
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
   * The amount actually PAID against a payment code, or `null` if the event
   * carries no usable evidence of it.
   *
   * Monime's public documentation puts the paid amount in different places
   * depending on the release, and never in `data.amount`:
   *  - `data.progress.totalPaymentSum` - the `2024-08-01` `payment_code.completed`
   *    sample (cumulative paid total);
   *  - `data.processedPaymentData.amount` - the `caph-2025-08-23` payment-code
   *    object (the single payment that was processed; documented as present on
   *    the `payment_code.processed` event);
   *  - `data.paymentData.amount` - the `2024-08-01` `payment_code.processed`
   *    sample.
   * Each is `{ currency, value }`, `value` an integer in the currency's minor
   * unit. Every location that IS present is read, and the result is fail-closed:
   * a present-but-malformed location, or two present locations that disagree
   * on amount or currency, yield `null`. At least one valid location is
   * required.
   *
   * PROVISIONAL / UNVERIFIED: these paths are transcribed from the public
   * documentation, which is internally inconsistent across releases and silent
   * on partial and over-payments, not from a captured `caph` delivery. It must
   * be re-checked against a real Test-mode `payment_code.completed` delivery
   * before this integration is considered production-ready.
   *
   * Deliberately NOT read: `data.amount`, the payment code's CONFIGURED amount.
   * It says what was asked for, not what was paid, so it is never used as a
   * substitute.
   */
  private readPaidAmount(
    data: Record<string, unknown> | undefined,
  ): { amountMinor: string; currency: string } | null {
    if (!data) return null;

    const at = (parent: unknown, key: string): unknown =>
      parent && typeof parent === 'object'
        ? (parent as Record<string, unknown>)[key]
        : undefined;

    const candidates: unknown[] = [
      at(data.progress, 'totalPaymentSum'),
      at(data.processedPaymentData, 'amount'),
      at(data.paymentData, 'amount'),
    ].filter((candidate) => candidate !== undefined && candidate !== null);
    if (candidates.length === 0) return null;

    const parsed = candidates.map((candidate) => this.toPaidMoney(candidate));
    if (parsed.some((money) => money === null)) return null;

    const [first, ...rest] = parsed as {
      amountMinor: string;
      currency: string;
    }[];
    const agree = rest.every(
      (money) =>
        money.amountMinor === first.amountMinor &&
        money.currency === first.currency,
    );
    return agree ? first : null;
  }

  private toPaidMoney(
    value: unknown,
  ): { amountMinor: string; currency: string } | null {
    if (!value || typeof value !== 'object') return null;
    const { currency, value: minor } = value as Record<string, unknown>;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      return null;
    }
    if (
      typeof minor !== 'number' ||
      !Number.isSafeInteger(minor) ||
      minor < 0
    ) {
      return null;
    }
    return { amountMinor: String(minor), currency };
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
    // Always pinned (never left to Monime's current default) so the payment
    // code and the webhook registered for the Space share one API release -
    // see monime.constants.ts.
    headers['Monime-Version'] =
      this.config.monimeApiVersion ?? MONIME_DEFAULT_API_VERSION;
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
