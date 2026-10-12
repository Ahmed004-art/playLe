import { Module } from '@nestjs/common';
import { WithdrawalsService } from './withdrawals.service.js';
import { WithdrawalsController } from './withdrawals.controller.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { NotificationOutboxModule } from '../notification-outbox/notification-outbox.module.js';

@Module({
  imports: [
    AuthModule,
    LedgerModule,
    WalletModule,
    PaymentsModule,
    NotificationOutboxModule,
  ],
  controllers: [WithdrawalsController],
  providers: [WithdrawalsService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
