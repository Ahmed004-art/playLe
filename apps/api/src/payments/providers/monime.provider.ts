import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../../config/configuration.js';
import type {
  InitiateDepositParams,
  InitiateDepositResult,
  PaymentProviderPort,
  WebhookVerificationResult,
} from '../ports/payment-provider.port.js';

/**
 * Monime integration boundary. Deliberately inert in Phase 3: no publicly
 * verifiable API documentation, endpoint shapes, or webhook signature
 * scheme exist for Monime as of this implementation (confirmed via web
 * search — see docs/development/MONIME_SETUP.md), so this class makes
 * **no real HTTP call to Monime, ever**, regardless of whether
 * `MONIME_API_KEY` is configured. It exists so the provider abstraction
 * (`PaymentProviderPort`) and the rest of the system (ledger, wallet,
 * deposit/withdrawal state machines) are already correct and ready the
 * moment official Monime docs/credentials become available — only this
 * file needs to change.
 *
 * Do not add a real HTTP call here without first verifying the request/
 * response shape and signature scheme against Monime's official developer
 * documentation. Guessing is explicitly disallowed by the Phase 3 spec.
 */
@Injectable()
export class MonimeProvider implements PaymentProviderPort {
  readonly name = 'MONIME';
  private readonly logger = new Logger(MonimeProvider.name);

  constructor(
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  initiateDeposit(
    _params: InitiateDepositParams,
  ): Promise<InitiateDepositResult> {
    const configured = Boolean(
      this.configService.get('payments.monimeApiKey', { infer: true }),
    );

    this.logger.warn(
      configured
        ? 'MONIME_API_KEY is set, but Monime API integration is not yet implemented ' +
            '(no verified official documentation was available at implementation time). ' +
            'Deposit left PENDING without a provider call — see docs/development/MONIME_SETUP.md.'
        : 'Monime is not configured (MONIME_API_KEY unset). Deposit left PENDING ' +
            'without a provider call — see docs/development/MONIME_SETUP.md.',
    );

    return Promise.resolve({ providerReference: null, status: 'UNAVAILABLE' });
  }

  verifyWebhookSignature(): WebhookVerificationResult {
    // Fail closed: Monime's real webhook signature scheme has not been
    // verified against official documentation, so no signature can ever
    // be trusted here yet. See docs/development/MONIME_SETUP.md.
    this.logger.warn(
      'Rejected a Monime webhook: signature verification is not yet implemented.',
    );
    return { valid: false };
  }
}
