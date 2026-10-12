import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationOutboxModule } from '../notification-outbox/notification-outbox.module.js';
import { EligibilityService } from './eligibility.service.js';
import { ResponsibleGamingService } from './responsible-gaming.service.js';
import { ResponsibleGamingController } from './responsible-gaming.controller.js';
import { AdminResponsibleGamingController } from './admin-responsible-gaming.controller.js';

@Module({
  imports: [AuthModule, NotificationOutboxModule],
  controllers: [ResponsibleGamingController, AdminResponsibleGamingController],
  providers: [EligibilityService, ResponsibleGamingService],
  exports: [EligibilityService, ResponsibleGamingService],
})
export class EligibilityModule {}
