import { Module } from '@nestjs/common';
import { SystemAccountService } from './system-account.service.js';

@Module({
  providers: [SystemAccountService],
  exports: [SystemAccountService],
})
export class SystemAccountModule {}
