import { Module } from '@nestjs/common';
import { DepositsService } from './deposits.service.js';
import { DepositsController } from './deposits.controller.js';
import { WebhooksController } from './webhooks.controller.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule, LedgerModule, WalletModule, PaymentsModule],
  controllers: [DepositsController, WebhooksController],
  providers: [DepositsService],
  exports: [DepositsService],
})
export class DepositsModule {}
