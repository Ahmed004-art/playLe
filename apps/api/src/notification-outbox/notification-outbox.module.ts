import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { NotificationOutboxService } from './notification-outbox.service.js';
import { NotificationDispatcherService } from './notification-dispatcher.service.js';

@Module({
  imports: [NotificationsModule],
  providers: [NotificationOutboxService, NotificationDispatcherService],
  exports: [NotificationOutboxService],
})
export class NotificationOutboxModule {}
