import { Module } from '@nestjs/common';
import { DELIVERY_PORT } from './ports/delivery.port.js';
import { FakeDeliveryAdapter } from './fake-delivery.adapter.js';

/**
 * Owns message delivery (`DeliveryPort`) for password-reset links,
 * verification codes, and (via the transactional outbox —
 * `NotificationOutbox`) financial/account-security notifications. Only
 * `FakeDeliveryAdapter` exists — selection logic mirrors
 * `PaymentsModule`'s provider factory and is the single place a real
 * email/SMS provider would be wired in later, once credentials exist
 * (see docs/development/PHASE_6_CHECKLIST.md item 6).
 */
@Module({
  providers: [
    FakeDeliveryAdapter,
    { provide: DELIVERY_PORT, useExisting: FakeDeliveryAdapter },
  ],
  exports: [DELIVERY_PORT, FakeDeliveryAdapter],
})
export class NotificationsModule {}
