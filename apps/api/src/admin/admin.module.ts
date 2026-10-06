import { Module } from '@nestjs/common';
import { AdminFinanceController } from './admin-finance.controller.js';
import { AdminFinanceService } from './admin-finance.service.js';
import { AdminMatchesController } from './admin-matches.controller.js';
import { AdminDisputesController } from './admin-disputes.controller.js';
import { AdminReconciliationController } from './admin-reconciliation.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { DepositsModule } from '../deposits/deposits.module.js';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module.js';
import { MatchesModule } from '../matches/matches.module.js';
import { MatchStakesModule } from '../match-stakes/match-stakes.module.js';
import { DisputesModule } from '../disputes/disputes.module.js';
import { SettlementModule } from '../settlement/settlement.module.js';

@Module({
  imports: [
    AuthModule,
    WalletModule,
    LedgerModule,
    DepositsModule,
    WithdrawalsModule,
    MatchesModule,
    MatchStakesModule,
    DisputesModule,
    SettlementModule,
  ],
  controllers: [
    AdminFinanceController,
    AdminMatchesController,
    AdminDisputesController,
    AdminReconciliationController,
  ],
  providers: [AdminFinanceService],
})
export class AdminModule {}
