import { Module } from '@nestjs/common';
import { SettlementService } from './settlement.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { SystemAccountModule } from '../system-account/system-account.module.js';

@Module({
  imports: [LedgerModule, WalletModule, SystemAccountModule],
  providers: [SettlementService, ReconciliationService],
  exports: [SettlementService, ReconciliationService],
})
export class SettlementModule {}
