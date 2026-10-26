import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { DepositsService } from './deposits.service.js';
import { WithdrawalsService } from '../withdrawals/withdrawals.service.js';

/**
 * Inbound payment-provider webhooks — both deposit (Payment Code) and
 * payout events arrive on this one endpoint. Deliberately **no**
 * `JwtAuthGuard` — the caller is an external provider, not a PlayLe user
 * — authenticity is established via
 * `PaymentProviderPort.verifyWebhookSignature` against the raw request
 * body instead. Excluded from Swagger since it's not a client-facing API
 * surface.
 *
 * The real Monime provider currently always fails this verification (see
 * MonimeProvider — the exact HMAC canonical string is not yet verified
 * against official documentation, see
 * docs/development/PHASE_6_CHECKLIST.md) — this endpoint exists as an
 * implemented, tested boundary (exercised in e2e tests via a fake
 * provider double), not as a claim that live Monime webhooks are being
 * verified yet.
 *
 * Routing: `verifyWebhookSignature` is called once here purely to peek at
 * the parsed payload's shape and decide which domain service owns this
 * event — exactly one of `DepositsService`/`WithdrawalsService` is then
 * invoked, each of which independently re-verifies and persists its own
 * `ProviderEvent` row. This avoids a race where both services could try
 * to create a `ProviderEvent` for the same provider event id (the
 * dedup-by-uniqueness mechanism only works if exactly one of them ever
 * attempts the insert for a given delivery).
 *
 * Response codes: a delivery whose authenticity cannot be established (no raw
 * body to verify, or a signature that does not verify) gets **401** and is not
 * processed. It must not be acknowledged with a 2xx: nothing is stored for it, so
 * a 200 would tell the sender the event was received while PlayLe silently
 * dropped it - no retry, no alert, a deposit never credited. A non-2xx lets the
 * sender retry and raise its delivery-failure notification. Every AUTHENTICATED
 * delivery gets 200, whatever the outcome (processed, a duplicate that is
 * ignored, or a business rejection such as an amount mismatch), so a valid
 * sender is never pushed into a retry storm over an event PlayLe has recorded.
 */
@ApiExcludeController()
@Controller({ path: 'payments/webhooks/monime', version: '1' })
export class WebhooksController {
  constructor(
    private readonly depositsService: DepositsService,
    private readonly withdrawalsService: WithdrawalsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ status: string }> {
    // Without the exact bytes received there is nothing to verify a signature
    // against; never fall back to verifying an empty or re-serialised body.
    if (!req.rawBody) {
      throw new UnauthorizedException('Webhook could not be authenticated');
    }
    const rawBody = req.rawBody.toString('utf-8');
    const headers = req.headers as Record<
      string,
      string | string[] | undefined
    >;

    const provider = this.depositsService.getProvider();
    const peek = provider.verifyWebhookSignature(rawBody, headers);
    if (!peek.valid) {
      // Not acknowledged: see the class comment. The body is never processed.
      throw new UnauthorizedException('Webhook could not be authenticated');
    }
    const isPayout =
      Boolean(peek.eventType) &&
      typeof peek.eventType === 'string' &&
      this.looksLikePayoutEvent(peek.parsedPayload);

    const status = isPayout
      ? await this.withdrawalsService.processProviderWebhook(rawBody, headers)
      : await this.depositsService.processProviderWebhook(rawBody, headers);

    // 200 for every authenticated delivery (processed, duplicate-ignored, or a
    // business rejection); the distinction is in the ProviderEvent audit log.
    return { status };
  }

  private looksLikePayoutEvent(payload: unknown): boolean {
    return (
      Boolean(payload) &&
      typeof payload === 'object' &&
      payload !== null &&
      'eventType' in payload &&
      typeof payload.eventType === 'string' &&
      (payload as { eventType: string }).eventType.startsWith('payout.')
    );
  }
}
