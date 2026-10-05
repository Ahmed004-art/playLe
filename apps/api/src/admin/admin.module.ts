import { Module } from '@nestjs/common';
import { AdminFinanceController } from './admin-finance.controller.js';
import { AdminFinanceService } from './admin-finance.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { DepositsModule } from '../deposits/deposits.module.js';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module.js';

@Module({
  imports: [
    AuthModule,
    WalletModule,
    LedgerModule,
    DepositsModule,
    WithdrawalsModule,
  ],
  controllers: [AdminFinanceController],
  providers: [AdminFinanceService],
})
export class AdminModule {}
