import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PAYMENT_PROVIDER } from './ports/payment-provider.port.js';
import { ManualProvider } from './providers/manual.provider.js';
import { MonimeProvider } from './providers/monime.provider.js';
import type { AppConfiguration } from '../config/configuration.js';

@Module({
  imports: [ConfigModule],
  providers: [
    ManualProvider,
    MonimeProvider,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService, ManualProvider, MonimeProvider],
      useFactory: (
        configService: ConfigService<AppConfiguration, true>,
        manual: ManualProvider,
        monime: MonimeProvider,
      ) =>
        configService.get('payments.provider', { infer: true }) === 'monime'
          ? monime
          : manual,
    },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
