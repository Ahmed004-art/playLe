import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  InitiateDepositParams,
  InitiateDepositResult,
  PaymentProviderPort,
  WebhookVerificationResult,
} from '../ports/payment-provider.port.js';

/**
 * The real, active default provider (`PAYMENTS_PROVIDER=manual`) while no
 * live external gateway is connected. Issues a real internal reference
 * and leaves the deposit `PENDING`, representing "recorded, confirmed
 * out-of-band" rather than fabricating a successful payment. Never makes
 * a network call.
 */
@Injectable()
export class ManualProvider implements PaymentProviderPort {
  readonly name = 'MANUAL';

  initiateDeposit(
    _params: InitiateDepositParams,
  ): Promise<InitiateDepositResult> {
    return Promise.resolve({
      providerReference: `manual_${randomUUID()}`,
      status: 'PENDING',
    });
  }

  verifyWebhookSignature(): WebhookVerificationResult {
    // Nothing calls PlayLe's webhook endpoint on behalf of "manual" — this
    // exists only for interface symmetry and is never exercised in
    // production.
    return { valid: false };
  }
}
