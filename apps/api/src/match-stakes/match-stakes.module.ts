import { Module } from '@nestjs/common';
import { MatchStakesService } from './match-stakes.service.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';

@Module({
  imports: [LedgerModule, WalletModule, RealtimeModule],
  providers: [MatchStakesService],
  exports: [MatchStakesService],
})
export class MatchStakesModule {}
