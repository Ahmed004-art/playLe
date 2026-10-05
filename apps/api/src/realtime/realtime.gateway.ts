import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { TokenService } from '../auth/token.service.js';
import { UsersService } from '../users/users.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PresenceService } from './presence.service.js';
import { RealtimeEmitterService } from './realtime-emitter.service.js';

interface SocketData {
  userId?: string;
}

/** `Socket.data` is untyped (`any`) by default — this is the one place that casts it. */
function getAuthenticatedUserId(client: Socket): string | undefined {
  return (client.data as SocketData).userId;
}

/**
 * Real-time gateway. Authenticated at the handshake (never a bare
 * "accept any connection" — see ADR-006/ADR-008): the client passes its
 * REST access token via `handshake.auth.token`, verified the same way
 * `JwtAuthGuard` verifies it for HTTP (same `TokenService`, same
 * `status !== 'ACTIVE'` rejection). On success the socket joins a
 * personal `user:{userId}` room — this is how `RealtimeEmitterService`
 * pushes events (match:found, challenge:received, ...) to a specific
 * user without needing to track socket ids itself.
 *
 * Match commands (moves) travel over REST, not this gateway — see
 * docs/decisions/ADR-014-realtime-command-transport.md. This gateway is
 * exclusively server→client push plus the `match:join` handshake that
 * lets a client subscribe to a specific match's room after REST has
 * already confirmed real membership (never trusted from the client
 * alone).
 */
@WebSocketGateway({ cors: true })
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit
{
  @WebSocketServer()
  private server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly tokenService: TokenService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly presenceService: PresenceService,
    private readonly emitter: RealtimeEmitterService,
  ) {}

  afterInit(server: Server): void {
    this.emitter.setServer(server);
  }

  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake.auth['token'] as string | undefined;

    if (!token) {
      this.logger.warn(`Rejected connection ${client.id}: missing auth token`);
      client.disconnect(true);
      return;
    }

    let userId: string;
    try {
      const payload = this.tokenService.verifyAccessToken(token);
      const user = await this.usersService.findById(payload.sub);
      if (!user || user.status !== 'ACTIVE') {
        throw new Error('Account not active');
      }
      userId = user.id;
    } catch {
      this.logger.warn(`Rejected connection ${client.id}: invalid token`);
      client.disconnect(true);
      return;
    }

    (client.data as SocketData).userId = userId;
    await client.join(`user:${userId}`);
    this.logger.log(`Client connected: ${client.id} (user ${userId})`);

    await this.presenceService.set(userId, 'ONLINE').catch(() => {
      // Presence is best-effort — Redis being unreachable must never
      // break the realtime connection itself.
    });

    await this.resumeDisconnectedMatches(userId);

    // Socket.IO's transport-level "connect" (observed by the client as
    // soon as the handshake completes) fires independently of — and can
    // race ahead of — this async handler finishing. A client that emits
    // `match:join` immediately on "connect" could arrive before
    // `client.data.userId` above is even set. "connected" is the real
    // signal that the server has finished authenticating this socket and
    // is ready to accept application messages.
    client.emit('connected', { userId });
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const userId = getAuthenticatedUserId(client);
    this.logger.log(`Client disconnected: ${client.id}`);
    if (!userId) return;

    await this.presenceService.clear(userId).catch(() => {});
    await this.markDisconnectedInActiveMatches(userId);
  }

  /**
   * The client calls this after REST has already told it which match it
   * belongs to (e.g. from `POST /matchmaking/join`'s `match:found` push,
   * or `GET /matches/:id` on reconnect) — membership is re-verified here
   * server-side, never trusted from the payload alone.
   */
  @SubscribeMessage('match:join')
  async handleMatchJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId?: string },
  ): Promise<void> {
    const userId = getAuthenticatedUserId(client);
    if (!userId || !data?.matchId) {
      client.emit('match:error', { message: 'Not authenticated' });
      return;
    }

    const membership = await this.prisma.matchPlayer.findUnique({
      where: { matchId_userId: { matchId: data.matchId, userId } },
    });

    if (!membership) {
      client.emit('match:error', {
        message: 'You are not a participant in this match',
      });
      return;
    }

    await client.join(`match:${data.matchId}`);
    client.emit('match:joined', { matchId: data.matchId });
  }

  @SubscribeMessage('presence:heartbeat')
  async handlePresenceHeartbeat(
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const userId = getAuthenticatedUserId(client);
    if (!userId) return;
    await this.presenceService.touch(userId).catch(() => {});
  }

  private async resumeDisconnectedMatches(userId: string): Promise<void> {
    const resumed = await this.prisma.matchPlayer.findMany({
      where: {
        userId,
        disconnectedAt: { not: null },
        match: { status: 'ACTIVE' },
      },
      select: { matchId: true },
    });
    if (resumed.length === 0) return;

    const matchIds = resumed.map((m) => m.matchId);
    await this.prisma.matchPlayer.updateMany({
      where: { userId, matchId: { in: matchIds } },
      data: { disconnectedAt: null },
    });

    for (const matchId of matchIds) {
      this.emitter.emitToMatch(matchId, 'player:reconnected', {
        matchId,
        userId,
      });
    }
  }

  private async markDisconnectedInActiveMatches(userId: string): Promise<void> {
    const active = await this.prisma.matchPlayer.findMany({
      where: { userId, leftAt: null, match: { status: 'ACTIVE' } },
      select: { matchId: true },
    });
    if (active.length === 0) return;

    const matchIds = active.map((m) => m.matchId);
    const now = new Date();
    await this.prisma.matchPlayer.updateMany({
      where: { userId, matchId: { in: matchIds } },
      data: { disconnectedAt: now },
    });

    for (const matchId of matchIds) {
      this.emitter.emitToMatch(matchId, 'player:left', {
        matchId,
        userId,
        reason: 'disconnected',
      });
    }
  }
}
