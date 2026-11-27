import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DepositsModule } from '../../deposits/deposits.module.js';
import { WithdrawalsModule } from '../../withdrawals/withdrawals.module.js';
import { PaymentsModule } from '../payments.module.js';
import { PaymentRecoveryService } from './payment-recovery.service.js';

/**
 * Separate from `PaymentsModule`, which `DepositsModule` and
 * `WithdrawalsModule` import: this one depends on both of them.
 */
@Module({
  imports: [ConfigModule, PaymentsModule, DepositsModule, WithdrawalsModule],
  providers: [PaymentRecoveryService],
  exports: [PaymentRecoveryService],
})
export class PaymentRecoveryModule {}
