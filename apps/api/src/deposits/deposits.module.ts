import { Module } from '@nestjs/common';
import { DepositsService } from './deposits.service.js';
import { DepositsController } from './deposits.controller.js';
import { WebhooksController } from './webhooks.controller.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module.js';
import { EligibilityModule } from '../eligibility/eligibility.module.js';
import { NotificationOutboxModule } from '../notification-outbox/notification-outbox.module.js';

@Module({
  imports: [
    AuthModule,
    LedgerModule,
    WalletModule,
    PaymentsModule,
    WithdrawalsModule,
    EligibilityModule,
    NotificationOutboxModule,
  ],
  controllers: [DepositsController, WebhooksController],
  providers: [DepositsService],
  exports: [DepositsService],
})
export class DepositsModule {}
