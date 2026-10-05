import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/** Resolves on the named event, or rejects if it doesn't fire in time. */
function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${event}"`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('Realtime gateway (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  const runId = randomUUID().slice(0, 8);
  const sockets: Socket[] = [];

  const email = (label: string) => `${label}-${runId}@example.com`;
  const username = (label: string) =>
    `${label.replace(/[^a-z0-9]/gi, '').slice(0, 6)}${randomUUID().replace(/-/g, '').slice(0, 10)}`.slice(
      0,
      20,
    );

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    // socket.io-client needs a real, listening network address — unlike
    // the REST e2e specs, which attach supertest directly to the
    // underlying http.Server without binding a port.
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;

    prisma = moduleFixture.get(PrismaService);
  });

  afterEach(() => {
    for (const socket of sockets) {
      socket.disconnect();
    }
    sockets.length = 0;
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { contains: runId } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    const matchIds = (
      await prisma.matchPlayer.findMany({
        where: { userId: { in: userIds } },
        select: { matchId: true },
      })
    ).map((m) => m.matchId);
    await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
    await prisma.challenge.deleteMany({
      where: {
        OR: [
          { challengerId: { in: userIds } },
          { opponentId: { in: userIds } },
        ],
      },
    });
    await prisma.refreshToken.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.ledgerEntry.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  async function registerUser(
    label: string,
  ): Promise<{ accessToken: string; userId: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: email(label),
        username: username(label),
        password: 'Passw0rd1',
        dateOfBirth: '2000-01-01',
      })
      .expect(201);
    return { accessToken: res.body.accessToken, userId: res.body.user.id };
  }

  function connectSocket(token?: string): Socket {
    const socket = io(baseUrl, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(socket);
    return socket;
  }

  it('accepts a connection with a valid access token', async () => {
    const { accessToken } = await registerUser('wsvalid');
    const socket = connectSocket(accessToken);
    await waitForEvent(socket, 'connect');
    expect(socket.connected).toBe(true);
  });

  /**
   * The server may reject an unauthenticated connection either during
   * the handshake (the client never observes "connect", only
   * "connect_error") or immediately after accepting it (`client.disconnect(true)`
   * in `handleConnection`, which the client observes as "connect" then
   * "disconnect") — both are a correct rejection. Race for either rather
   * than assuming one specific sequence.
   */
  function waitForRejection(socket: Socket, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for connection rejection')),
        timeoutMs,
      );
      const onRejected = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.once('disconnect', onRejected);
      socket.once('connect_error', onRejected);
    });
  }

  it('disconnects a connection with no auth token', async () => {
    const socket = connectSocket(undefined);
    await waitForRejection(socket);
    expect(socket.connected).toBe(false);
  });

  it('disconnects a connection with an invalid/garbage token', async () => {
    const socket = connectSocket('not-a-real-token');
    await waitForRejection(socket);
    expect(socket.connected).toBe(false);
  });

  it('rejects match:join when the socket is not a real participant', async () => {
    const { matchId } = await createActiveMatch('wsnonmember');
    const outsider = await registerUser('wsoutsider');
    const socket = connectSocket(outsider.accessToken);
    // Wait for the server's "connected" ack, not the client's own
    // transport-level "connect" — see the comment in
    // RealtimeGateway.handleConnection for why these can race.
    await waitForEvent(socket, 'connected');

    socket.emit('match:join', { matchId });
    const error = await waitForEvent<{ message: string }>(
      socket,
      'match:error',
    );
    expect(error.message).toMatch(/not a participant/i);
  }, 15000);

  it('lets a real participant join the match room', async () => {
    const { matchId, x } = await createActiveMatch('wsmember');
    const socket = connectSocket(x.accessToken);
    await waitForEvent(socket, 'connected');

    socket.emit('match:join', { matchId });
    const joined = await waitForEvent<{ matchId: string }>(
      socket,
      'match:joined',
    );
    expect(joined.matchId).toBe(matchId);
  }, 15000);

  it('pushes match:state to the other player when a move is submitted over REST', async () => {
    const { matchId, x, o } = await createActiveMatch('wspush');

    const xSocket = connectSocket(x.accessToken);
    const oSocket = connectSocket(o.accessToken);
    await Promise.all([
      waitForEvent(xSocket, 'connected'),
      waitForEvent(oSocket, 'connected'),
    ]);

    oSocket.emit('match:join', { matchId });
    await waitForEvent(oSocket, 'match:joined');

    const statePushPromise = waitForEvent<{
      matchId: string;
      stateVersion: number;
    }>(oSocket, 'match:state');

    await request(app.getHttpServer())
      .post(`/api/v1/matches/${matchId}/commands`)
      .set('Authorization', `Bearer ${x.accessToken}`)
      .send({ commandId: randomUUID(), payload: { cell: 4 } })
      .expect(200);

    const push = await statePushPromise;
    expect(push.matchId).toBe(matchId);
    expect(push.stateVersion).toBe(1);
  }, 15000);

  async function createActiveMatch(labelPrefix: string): Promise<{
    matchId: string;
    x: { accessToken: string; userId: string };
    o: { accessToken: string; userId: string };
  }> {
    const x = await registerUser(`${labelPrefix}x`);
    const o = await registerUser(`${labelPrefix}o`);

    const challenge = await request(app.getHttpServer())
      .post('/api/v1/challenges')
      .set('Authorization', `Bearer ${x.accessToken}`)
      .send({ gameId: 'tic_tac_toe', opponentUserId: o.userId })
      .expect(201);

    const accepted = await request(app.getHttpServer())
      .post(`/api/v1/challenges/${challenge.body.id}/accept`)
      .set('Authorization', `Bearer ${o.accessToken}`)
      .expect(200);

    return { matchId: accepted.body.matchId as string, x, o };
  }
});
