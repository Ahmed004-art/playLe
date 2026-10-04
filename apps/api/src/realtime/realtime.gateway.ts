import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';

/**
 * Real-time gateway foundation.
 *
 * Phase 1 implements connection lifecycle only — no game, matchmaking, or
 * chat events. See docs/decisions/ADR-006-realtime.md and
 * docs/architecture/GAME_ENGINE.md for the intended authoritative flow:
 *
 *   client action -> server receives -> server validates -> server
 *   updates authoritative state -> server emits event -> clients update UI
 *
 * Event naming convention (for future event handlers added to this
 * gateway): `<domain>:<action>`, e.g. `match:action`, `match:state`,
 * `matchmaking:queued`. Keep domain and action lowercase, colon-separated.
 *
 * Authentication architecture (future): the handshake will carry a
 * session token (e.g. `socket.handshake.auth.token`) validated by a
 * dedicated WS auth guard before a connection is accepted into any
 * domain-specific room. No token validation exists yet — this gateway
 * currently accepts any connection, which is acceptable only because no
 * gameplay-affecting or financial event is emitted here.
 */
@WebSocketGateway({ cors: true })
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }
}
