import { Module } from '@nestjs/common';
import { DisputesService } from './disputes.service.js';
import { DisputesController } from './disputes.controller.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
