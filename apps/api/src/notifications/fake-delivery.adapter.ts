import { Injectable, Logger } from '@nestjs/common';
import type { DeliveryMessage, DeliveryPort } from './ports/delivery.port.js';

/**
 * The only delivery adapter wired up this phase — no real email/SMS
 * provider credentials exist yet (see
 * docs/development/PHASE_6_CHECKLIST.md item 6). Never claims to
 * actually deliver anything: it logs the message and keeps a bounded
 * in-memory record purely so tests (and, in non-production
 * environments, a developer) can inspect what *would* have been sent —
 * e.g. to read a password-reset link or verification code without a
 * real inbox. This must never be selected in a real production
 * deployment; see `NotificationsModule` for the (currently unused)
 * selection point a real adapter would plug into.
 */
@Injectable()
export class FakeDeliveryAdapter implements DeliveryPort {
  readonly name = 'FAKE';
  private readonly logger = new Logger(FakeDeliveryAdapter.name);
  private readonly sent: DeliveryMessage[] = [];
  private static readonly MAX_RETAINED = 500;

  send(message: DeliveryMessage): Promise<void> {
    this.logger.warn(
      `FakeDeliveryAdapter: not a real delivery — ${message.channel} to ${message.to}: ${message.subject ?? ''} ${message.body}`.trim(),
    );
    this.sent.push(message);
    if (this.sent.length > FakeDeliveryAdapter.MAX_RETAINED) {
      this.sent.shift();
    }
    return Promise.resolve();
  }

  /** Test/dev-only introspection — never used by any production code path. */
  getSent(): readonly DeliveryMessage[] {
    return this.sent;
  }

  /** Test helper. */
  clear(): void {
    this.sent.length = 0;
  }
}
