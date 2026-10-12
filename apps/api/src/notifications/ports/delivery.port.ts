/**
 * The boundary every outbound message channel (email, SMS) must
 * implement. No real delivery provider is integrated this phase — see
 * docs/development/PHASE_6_CHECKLIST.md item 6. `FakeDeliveryAdapter` is
 * the only implementation until the owner supplies real credentials, and
 * it is explicitly never claimed to be a production delivery mechanism.
 */
export const DELIVERY_PORT = Symbol('DELIVERY_PORT');

export type DeliveryChannel = 'EMAIL' | 'SMS';

export interface DeliveryMessage {
  channel: DeliveryChannel;
  to: string;
  subject?: string;
  body: string;
}

export interface DeliveryPort {
  readonly name: string;
  send(message: DeliveryMessage): Promise<void>;
}
