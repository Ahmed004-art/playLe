import { Module } from '@nestjs/common';
import { WithdrawalsService } from './withdrawals.service.js';
import { WithdrawalsController } from './withdrawals.controller.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule, LedgerModule, WalletModule],
  controllers: [WithdrawalsController],
  providers: [WithdrawalsService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
