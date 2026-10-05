import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';

/**
 * Lets other modules (`MatchesService`, `MatchmakingService`,
 * `ChallengesService`) push real-time events without depending on
 * `RealtimeGateway` directly. The gateway registers its `Server` instance
 * here from `afterInit` (see `OnGatewayInit`); until then, emits are
 * silently dropped (logged) rather than throwing — a push notification
 * failing must never fail the REST request that triggered it.
 */
@Injectable()
export class RealtimeEmitterService {
  private readonly logger = new Logger(RealtimeEmitterService.name);
  private server: Server | null = null;

  setServer(server: Server): void {
    this.server = server;
  }

  /** Pushes to every connection a specific user currently has open. */
  emitToUser(userId: string, event: string, payload: unknown): void {
    this.emitToRoom(`user:${userId}`, event, payload);
  }

  /** Pushes to every socket that has joined a match's room (see `match:join`). */
  emitToMatch(matchId: string, event: string, payload: unknown): void {
    this.emitToRoom(`match:${matchId}`, event, payload);
  }

  private emitToRoom(room: string, event: string, payload: unknown): void {
    if (!this.server) {
      this.logger.warn(
        `Dropped realtime event "${event}" for room "${room}" — gateway not yet initialized`,
      );
      return;
    }
    this.server.to(room).emit(event, payload);
  }
}
