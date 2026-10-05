import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { DepositsService } from './deposits.service.js';

/**
 * Inbound payment-provider webhooks. Deliberately **no** `JwtAuthGuard` —
 * the caller is an external provider, not a PlayLe user — authenticity is
 * established via `PaymentProviderPort.verifyWebhookSignature` against the
 * raw request body instead. Excluded from Swagger since it's not a
 * client-facing API surface.
 *
 * The real Monime provider currently always fails this verification (see
 * MonimeProvider) — this endpoint exists as an implemented, tested
 * boundary (exercised in e2e tests via a fake provider double), not as a
 * claim that live Monime webhooks are being verified yet.
 */
@ApiExcludeController()
@Controller({ path: 'payments/webhooks/monime', version: '1' })
export class WebhooksController {
  constructor(private readonly depositsService: DepositsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ status: string }> {
    const rawBody = req.rawBody ? req.rawBody.toString('utf-8') : '';
    const headers = req.headers as Record<
      string,
      string | string[] | undefined
    >;

    const status = await this.depositsService.processProviderWebhook(
      rawBody,
      headers,
    );

    // Always 200 for a syntactically-handled delivery (including rejected/
    // ignored) so the provider doesn't retry-storm us over something we
    // deliberately chose not to apply; the distinction is visible in our
    // own ProviderEvent audit log, not in the HTTP status.
    return { status };
  }
}
