import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
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
  WebhookVerificationResult,
} from '../ports/payment-provider.port.js';

/**
 * The real, active default provider (`PAYMENTS_PROVIDER=manual`) while no
 * live external gateway is connected. Issues a real internal reference
 * and leaves the deposit `PENDING`, representing "recorded, confirmed
 * out-of-band" rather than fabricating a successful payment. Never makes
 * a network call. Payouts are never submitted by this provider — a
 * withdrawal stays on the existing admin-reviewed manual completion path
 * (`WithdrawalsService.complete`/`fail`) exactly as in Phase 3.
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

  checkDepositStatus(
    _params: CheckDepositStatusParams,
  ): Promise<CheckDepositStatusResult> {
    // No real provider ever confirms a manual deposit's status — it is
    // resolved out-of-band (admin ledger adjustment), never via this
    // path. `UNKNOWN` is the honest answer, not a guess at success.
    return Promise.resolve({ outcome: 'UNKNOWN' });
  }

  initiatePayout(_params: InitiatePayoutParams): Promise<InitiatePayoutResult> {
    return Promise.resolve({ providerReference: null, outcome: 'UNAVAILABLE' });
  }

  checkPayoutStatus(
    _params: CheckPayoutStatusParams,
  ): Promise<CheckPayoutStatusResult> {
    return Promise.resolve({ outcome: 'UNKNOWN' });
  }

  verifyWebhookSignature(): WebhookVerificationResult {
    // Nothing calls PlayLe's webhook endpoint on behalf of "manual" — this
    // exists only for interface symmetry and is never exercised in
    // production.
    return { valid: false };
  }
}
