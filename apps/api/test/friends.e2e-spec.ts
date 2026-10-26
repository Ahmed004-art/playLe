import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PresenceService } from '../src/realtime/presence.service.js';
import { lockUserPair, orderPair, pairKeyOf } from '../src/blocks/pair-lock.js';
import {
  MAX_FRIENDS,
  MAX_OUTGOING_PENDING_REQUESTS,
} from '../src/friends/friends.constants.js';
import { waitForBackendBlockedBy } from './pg-locks.js';

/**
 * Phase 12 PR 3 - friend requests, friendships, friend presence, realtime
 * events and their interaction with blocking (see
 * docs/decisions/ADR-026-social-foundation.md). Runs in CI only: it needs
 * Postgres and Redis. The constraint tests write rows directly so the real
 * CHECK constraints and unique indexes are what refuse them; the concurrency
 * tests either hold the real pair lock to force an interleaving or race real
 * requests and assert an invariant that must hold under every interleaving.
 */
describe('Friends, friend requests, presence and realtime (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let presenceService: PresenceService;
  let baseUrl: string;
  const runId = randomUUID().slice(0, 8);
  const sockets: Socket[] = [];
  const touchedPresence: string[] = [];

  const email = (label: string) => `${label}-${runId}@example.com`;
  const username = (label: string) =>
    `${label.replace(/[^a-z0-9]/gi, '').slice(0, 6)}${randomUUID().replace(/-/g, '').slice(0, 10)}`.slice(
      0,
      20,
    );

  type Player = { accessToken: string; userId: string; username: string };

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
    // socket.io-client needs a real, listening address (see realtime.e2e-spec).
    await app.listen(0);
    baseUrl = `http://localhost:${(app.getHttpServer().address() as AddressInfo).port}`;

    prisma = moduleFixture.get(PrismaService);
    presenceService = moduleFixture.get(PresenceService);
  }, 30000);

  afterEach(async () => {
    for (const socket of sockets) socket.disconnect();
    sockets.length = 0;
    for (const id of touchedPresence) {
      await presenceService.clear(id).catch(() => undefined);
    }
    touchedPresence.length = 0;
    vi.restoreAllMocks();
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

    await prisma.challenge.deleteMany({
      where: {
        OR: [
          { challengerId: { in: userIds } },
          { opponentId: { in: userIds } },
        ],
      },
    });
    await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
    await prisma.friendship.deleteMany({
      where: {
        OR: [{ userLowId: { in: userIds } }, { userHighId: { in: userIds } }],
      },
    });
    await prisma.friendRequest.deleteMany({
      where: {
        OR: [
          { requesterId: { in: userIds } },
          { addresseeId: { in: userIds } },
        ],
      },
    });
    await prisma.userBlock.deleteMany({
      where: {
        OR: [{ blockerId: { in: userIds } }, { blockedId: { in: userIds } }],
      },
    });
    await prisma.refreshToken.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  // ---- helpers ------------------------------------------------------------

  async function registerUser(label: string): Promise<Player> {
    const name = username(label);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: email(label),
        username: name,
        password: 'Passw0rd1',
        dateOfBirth: '2000-01-01',
      })
      .expect(201);
    return {
      accessToken: res.body.accessToken,
      userId: res.body.user.id,
      username: name,
    };
  }

  /** Users written straight to the table: fast, for fixtures that need many. */
  async function bulkUsers(label: string, count: number): Promise<string[]> {
    const rows = Array.from({ length: count }, (_, i) => ({
      id: randomUUID(),
      email: `${label}${i}-${runId}@example.com`,
      username: `${label}${i}${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      passwordHash: 'not-a-real-hash',
      dateOfBirth: new Date('2000-01-01'),
    }));
    await prisma.user.createMany({ data: rows });
    return rows.map((r) => r.id);
  }

  const auth = (p: Player) => ({ Authorization: `Bearer ${p.accessToken}` });
  const api = () => request(app.getHttpServer());

  const send = (from: Player, to: { userId: string }) =>
    api()
      .post('/api/v1/friends/requests')
      .set(auth(from))
      .send({ userId: to.userId });
  const accept = (by: Player, id: string) =>
    api().post(`/api/v1/friends/requests/${id}/accept`).set(auth(by));
  const decline = (by: Player, id: string) =>
    api().post(`/api/v1/friends/requests/${id}/decline`).set(auth(by));
  const cancel = (by: Player, id: string) =>
    api().post(`/api/v1/friends/requests/${id}/cancel`).set(auth(by));
  const listRequests = (by: Player, direction?: string) =>
    api()
      .get(
        `/api/v1/friends/requests${direction ? `?direction=${direction}` : ''}`,
      )
      .set(auth(by));
  const listFriends = (by: Player, query = '') =>
    api().get(`/api/v1/friends${query}`).set(auth(by));
  const removeFriend = (by: Player, friend: { userId: string }) =>
    api().delete(`/api/v1/friends/${friend.userId}`).set(auth(by));
  const block = (by: Player, target: { userId: string }) =>
    api().post('/api/v1/blocks').set(auth(by)).send({ userId: target.userId });
  const unblock = (by: Player, target: { userId: string }) =>
    api().delete(`/api/v1/blocks/${target.userId}`).set(auth(by));

  const friendshipsOf = (userId: string) =>
    prisma.friendship.count({
      where: { OR: [{ userLowId: userId }, { userHighId: userId }] },
    });
  const friendshipBetween = (a: string, b: string) => {
    const { low, high } = orderPair(a, b);
    return prisma.friendship.count({
      where: { userLowId: low, userHighId: high },
    });
  };
  const requestsBetween = (a: string, b: string) =>
    prisma.friendRequest.findMany({
      where: {
        OR: [
          { requesterId: a, addresseeId: b },
          { requesterId: b, addresseeId: a },
        ],
      },
    });

  async function makeFriends(a: { userId: string }, b: { userId: string }) {
    const { low, high } = orderPair(a.userId, b.userId);
    await prisma.friendship.create({
      data: { userLowId: low, userHighId: high },
    });
  }

  const pendingRow = (requesterId: string, addresseeId: string) => ({
    id: randomUUID(),
    requesterId,
    addresseeId,
    status: 'PENDING' as const,
    pendingPairKey: pairKeyOf(requesterId, addresseeId),
  });

  /**
   * Holds the real pair lock in a test-owned transaction, standing in for
   * whichever of block/accept/send is "first", so the request under test must
   * wait for it. `whileHeld` runs inside that transaction before it commits.
   */
  async function holdPairLock(
    a: { userId: string },
    b: { userId: string },
    whileHeld: (tx: Prisma.TransactionClient) => Promise<void> = () =>
      Promise.resolve(),
  ) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pid!: number;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const held = prisma.$transaction(
      async (tx) => {
        await lockUserPair(tx, a.userId, b.userId);
        const [row] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        pid = row.pid;
        acquired();
        await gate;
        await whileHeld(tx);
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    await ready;
    return { pid, release, held };
  }

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function connect(player: Player): Socket {
    const socket = io(baseUrl, {
      auth: { token: player.accessToken },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(socket);
    return socket;
  }

  /** Connects and waits for the server's "connected" ack, recording events. */
  async function listen(player: Player, events: string[]) {
    const socket = connect(player);
    const received: { event: string; payload: unknown }[] = [];
    for (const event of events) {
      socket.on(event, (payload: unknown) => received.push({ event, payload }));
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket timeout')), 5000);
      socket.once('connected', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return received;
  }

  async function waitForEventCount(
    received: unknown[],
    count: number,
    timeoutMs = 5000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (received.length < count && Date.now() < deadline) await wait(25);
    expect(received.length).toBeGreaterThanOrEqual(count);
  }

  // ---- lifecycle -----------------------------------------------------------

  describe('authentication and validation', () => {
    it('requires authentication on every route', async () => {
      const id = randomUUID();
      await api().get('/api/v1/friends').expect(401);
      await api().get('/api/v1/friends/requests').expect(401);
      await api()
        .post('/api/v1/friends/requests')
        .send({ userId: id })
        .expect(401);
      await api().post(`/api/v1/friends/requests/${id}/accept`).expect(401);
      await api().post(`/api/v1/friends/requests/${id}/decline`).expect(401);
      await api().post(`/api/v1/friends/requests/${id}/cancel`).expect(401);
      await api().delete(`/api/v1/friends/${id}`).expect(401);
    });

    it('rejects malformed ids (400), self-requests (400) and unknown players (404)', async () => {
      const a = await registerUser('val1');

      await api()
        .post('/api/v1/friends/requests')
        .set(auth(a))
        .send({ userId: 'not-a-uuid' })
        .expect(400);
      await api()
        .post('/api/v1/friends/requests')
        .set(auth(a))
        .send({})
        .expect(400);
      await send(a, a).expect(400);
      await send(a, { userId: randomUUID() }).expect(404);
      await api()
        .post('/api/v1/friends/requests/nope/accept')
        .set(auth(a))
        .expect(400);
      await api().delete('/api/v1/friends/nope').set(auth(a)).expect(400);
      await listRequests(a, 'sideways').expect(400);
    });

    it('a player who is not ACTIVE cannot be asked', async () => {
      const a = await registerUser('val2a');
      const b = await registerUser('val2b');
      await prisma.user.update({
        where: { id: b.userId },
        data: { status: 'SUSPENDED' },
      });

      await send(a, b).expect(404);
    });
  });

  describe('request lifecycle', () => {
    it('sends, lists in both directions, accepts, and creates one canonical friendship', async () => {
      const a = await registerUser('lc1a');
      const b = await registerUser('lc1b');

      const sent = await send(a, b).expect(201);
      expect(sent.body).toMatchObject({
        status: 'PENDING',
        direction: 'OUTGOING',
        player: { id: b.userId, username: b.username, displayName: null },
        respondedAt: null,
      });
      expect(Object.keys(sent.body).sort()).toEqual([
        'createdAt',
        'direction',
        'id',
        'player',
        'respondedAt',
        'status',
      ]);

      const row = await prisma.friendRequest.findUniqueOrThrow({
        where: { id: sent.body.id },
      });
      expect(row.pendingPairKey).toBe(pairKeyOf(a.userId, b.userId));

      const outgoing = await listRequests(a, 'outgoing').expect(200);
      const incoming = await listRequests(b).expect(200);
      expect(outgoing.body.items.map((i: { id: string }) => i.id)).toEqual([
        sent.body.id,
      ]);
      expect(incoming.body.items).toHaveLength(1);
      expect(incoming.body.items[0]).toMatchObject({
        id: sent.body.id,
        direction: 'INCOMING',
        player: { id: a.userId },
      });
      expect((await listRequests(a).expect(200)).body.items).toEqual([]);
      expect(
        (await listRequests(b, 'outgoing').expect(200)).body.items,
      ).toEqual([]);

      const accepted = await accept(b, sent.body.id).expect(200);
      expect(accepted.body.status).toBe('ACCEPTED');

      const stored = await prisma.friendRequest.findUniqueOrThrow({
        where: { id: sent.body.id },
      });
      expect(stored).toMatchObject({
        status: 'ACCEPTED',
        pendingPairKey: null,
      });
      expect(await friendshipBetween(a.userId, b.userId)).toBe(1);
      const { low, high } = orderPair(a.userId, b.userId);
      expect(
        await prisma.friendship.findMany({
          where: { userLowId: low, userHighId: high },
        }),
      ).toHaveLength(1);

      const friendsOfA = await listFriends(a).expect(200);
      const friendsOfB = await listFriends(b).expect(200);
      expect(friendsOfA.body.items[0]).toMatchObject({
        userId: b.userId,
        username: b.username,
        presence: 'OFFLINE',
      });
      expect(friendsOfB.body.items[0]).toMatchObject({ userId: a.userId });
      expect((await listRequests(b).expect(200)).body.items).toEqual([]);
    });

    it('only the right party may act: the recipient accepts/declines, the sender cancels, strangers get 404', async () => {
      const a = await registerUser('own1a');
      const b = await registerUser('own1b');
      const c = await registerUser('own1c');
      const req = (await send(a, b).expect(201)).body.id as string;

      await accept(a, req).expect(403);
      await decline(a, req).expect(403);
      await cancel(b, req).expect(403);
      await accept(c, req).expect(404);
      await decline(c, req).expect(404);
      await cancel(c, req).expect(404);
      await accept(b, randomUUID()).expect(404);

      expect(await friendshipsOf(a.userId)).toBe(0);
      expect(
        (await prisma.friendRequest.findUniqueOrThrow({ where: { id: req } }))
          .status,
      ).toBe('PENDING');
    });

    it('decline and cancel resolve the request, free the pair for a new one, and create no friendship', async () => {
      const a = await registerUser('res1a');
      const b = await registerUser('res1b');

      const first = (await send(a, b).expect(201)).body.id as string;
      const declined = await decline(b, first).expect(200);
      expect(declined.body.status).toBe('DECLINED');
      await decline(b, first).expect(409);
      await accept(b, first).expect(409);

      const second = (await send(a, b).expect(201)).body.id as string;
      const cancelled = await cancel(a, second).expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      await cancel(a, second).expect(409);

      await send(a, b).expect(201);
      expect(await friendshipsOf(a.userId)).toBe(0);
      const rows = await requestsBetween(a.userId, b.userId);
      expect(rows.map((r) => r.status).sort()).toEqual([
        'CANCELLED',
        'DECLINED',
        'PENDING',
      ]);
      expect(rows.filter((r) => r.pendingPairKey !== null)).toHaveLength(1);
    });

    it('a duplicate send is a 409, and so is asking someone who is already a friend', async () => {
      const a = await registerUser('dup1a');
      const b = await registerUser('dup1b');
      await send(a, b).expect(201);

      await send(a, b).expect(409);
      expect(await requestsBetween(a.userId, b.userId)).toHaveLength(1);

      await accept(
        b,
        (await listRequests(b).expect(200)).body.items[0].id,
      ).expect(200);
      await send(a, b).expect(409);
      await send(b, a).expect(409);
      expect(await friendshipsOf(a.userId)).toBe(1);
    });

    it('removing a friend deletes the friendship, 404s if repeated, does not block, and nothing recreates it', async () => {
      const a = await registerUser('rm1a');
      const b = await registerUser('rm1b');
      await makeFriends(a, b);

      await removeFriend(b, a).expect(204);
      expect(await friendshipBetween(a.userId, b.userId)).toBe(0);
      await removeFriend(b, a).expect(404);
      await removeFriend(a, a).expect(400);
      expect((await listFriends(a).expect(200)).body.items).toEqual([]);
      expect(await requestsBetween(a.userId, b.userId)).toHaveLength(0);

      // Not blocked: either can simply ask again, as a brand-new request.
      await send(a, b).expect(201);
      expect(await friendshipBetween(a.userId, b.userId)).toBe(0);
    });

    it('pages the friends list with a cursor', async () => {
      const a = await registerUser('pg1a');
      const friends = [
        await registerUser('pg1b'),
        await registerUser('pg1c'),
        await registerUser('pg1d'),
      ];
      for (const f of friends) await makeFriends(a, f);

      const first = await listFriends(a, '?limit=2').expect(200);
      const second = await listFriends(
        a,
        `?limit=2&cursor=${first.body.nextCursor}`,
      ).expect(200);

      expect(first.body.items).toHaveLength(2);
      expect(second.body.items).toHaveLength(1);
      expect(second.body.nextCursor).toBeNull();
      expect(
        new Set(
          [...first.body.items, ...second.body.items].map(
            (i: { userId: string }) => i.userId,
          ),
        ),
      ).toEqual(new Set(friends.map((f) => f.userId)));
    });
  });

  describe('database constraints (rows written directly)', () => {
    it('refuses a self-request and a self-friendship', async () => {
      const [u] = await bulkUsers('con1', 1);

      await expect(
        prisma.friendRequest.create({
          data: { requesterId: u, addresseeId: u, pendingPairKey: `${u}:${u}` },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.friendship.create({ data: { userLowId: u, userHighId: u } }),
      ).rejects.toThrow();
    });

    it('allows at most one open request per unordered pair, in either direction', async () => {
      const [x, y] = await bulkUsers('con2', 2);
      await prisma.friendRequest.create({ data: pendingRow(x, y) });

      await expect(
        prisma.friendRequest.create({ data: pendingRow(x, y) }),
      ).rejects.toThrow();
      await expect(
        prisma.friendRequest.create({ data: pendingRow(y, x) }),
      ).rejects.toThrow();
    });

    it('allows any number of resolved requests for the same pair', async () => {
      const [x, y] = await bulkUsers('con3', 2);

      for (const status of ['DECLINED', 'CANCELLED', 'ACCEPTED'] as const) {
        await prisma.friendRequest.create({
          data: {
            requesterId: x,
            addresseeId: y,
            status,
            pendingPairKey: null,
          },
        });
      }
      await prisma.friendRequest.create({ data: pendingRow(y, x) });

      expect(await requestsBetween(x, y)).toHaveLength(4);
    });

    it('requires pendingPairKey exactly while PENDING, and exactly the sorted pair', async () => {
      const [x, y] = await bulkUsers('con4', 2);

      // PENDING without a key.
      await expect(
        prisma.friendRequest.create({
          data: {
            requesterId: x,
            addresseeId: y,
            status: 'PENDING',
            pendingPairKey: null,
          },
        }),
      ).rejects.toThrow();
      // Resolved but still holding a key.
      await expect(
        prisma.friendRequest.create({
          data: {
            requesterId: x,
            addresseeId: y,
            status: 'DECLINED',
            pendingPairKey: pairKeyOf(x, y),
          },
        }),
      ).rejects.toThrow();
      // A key that is not the sorted pair (wrong order / wrong ids).
      const { low, high } = orderPair(x, y);
      await expect(
        prisma.friendRequest.create({
          data: {
            requesterId: x,
            addresseeId: y,
            pendingPairKey: `${high}:${low}`,
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.friendRequest.create({
          data: {
            requesterId: x,
            addresseeId: y,
            pendingPairKey: `${x}:${randomUUID()}`,
          },
        }),
      ).rejects.toThrow();
    });

    it('stores a friendship only canonically (low < high) and only once per pair', async () => {
      const [x, y] = await bulkUsers('con5', 2);
      const { low, high } = orderPair(x, y);

      await expect(
        prisma.friendship.create({
          data: { userLowId: high, userHighId: low },
        }),
      ).rejects.toThrow();
      await prisma.friendship.create({
        data: { userLowId: low, userHighId: high },
      });
      await expect(
        prisma.friendship.create({
          data: { userLowId: low, userHighId: high },
        }),
      ).rejects.toThrow();
      expect(await friendshipBetween(x, y)).toBe(1);
    });

    it('deleting a user removes their requests and friendships', async () => {
      const [x, y, z] = await bulkUsers('con6', 3);
      await prisma.friendRequest.create({ data: pendingRow(x, y) });
      const { low, high } = orderPair(x, z);
      await prisma.friendship.create({
        data: { userLowId: low, userHighId: high },
      });

      await prisma.user.delete({ where: { id: x } });

      expect(await requestsBetween(x, y)).toHaveLength(0);
      expect(await friendshipBetween(x, z)).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('concurrent identical sends make exactly one request', async () => {
      const a = await registerUser('cc1a');
      const b = await registerUser('cc1b');

      // Four at once: every waiter holds a pooled connection while it waits for
      // the pair lock, so this stays well inside the pool of a small CI runner.
      const results = await Promise.all(
        Array.from({ length: 4 }, () => send(a, b)),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(3);
      expect(await requestsBetween(a.userId, b.userId)).toHaveLength(1);
    });

    it('crossed requests sent at the same moment produce exactly one friendship and one request row', async () => {
      for (let i = 0; i < 4; i += 1) {
        const a = await registerUser(`cc2a${i}`);
        const b = await registerUser(`cc2b${i}`);

        const [ab, ba] = await Promise.all([send(a, b), send(b, a)]);

        expect([ab.status, ba.status]).toEqual([201, 201]);
        expect([ab.body.status, ba.body.status].sort()).toEqual([
          'ACCEPTED',
          'PENDING',
        ]);
        expect(await friendshipBetween(a.userId, b.userId)).toBe(1);
        const rows = await requestsBetween(a.userId, b.userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: 'ACCEPTED',
          pendingPairKey: null,
        });
      }
    });

    it('two concurrent accepts of one request make one friendship', async () => {
      const a = await registerUser('cc3a');
      const b = await registerUser('cc3b');
      const req = (await send(a, b).expect(201)).body.id as string;

      const results = await Promise.all([accept(b, req), accept(b, req)]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await friendshipsOf(a.userId)).toBe(1);
    });

    it(`refuses the ${MAX_OUTGOING_PENDING_REQUESTS + 1}th pending request`, async () => {
      const a = await registerUser('lim1a');
      const targets = await bulkUsers('lim1t', MAX_OUTGOING_PENDING_REQUESTS);
      await prisma.friendRequest.createMany({
        data: targets.map((t) => pendingRow(a.userId, t)),
      });
      const [extra] = await bulkUsers('lim1x', 1);

      const res = await send(a, { userId: extra }).expect(409);

      expect(res.body.message).toContain(String(MAX_OUTGOING_PENDING_REQUESTS));
      expect(await requestsBetween(a.userId, extra)).toHaveLength(0);
    });

    it('two concurrent sends from a player with one slot left make exactly one request', async () => {
      const a = await registerUser('lim2a');
      const seeded = await bulkUsers(
        'lim2t',
        MAX_OUTGOING_PENDING_REQUESTS - 1,
      );
      await prisma.friendRequest.createMany({
        data: seeded.map((t) => pendingRow(a.userId, t)),
      });
      const [t1, t2] = await bulkUsers('lim2x', 2);

      const results = await Promise.all([
        send(a, { userId: t1 }),
        send(a, { userId: t2 }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        await prisma.friendRequest.count({
          where: { requesterId: a.userId, status: 'PENDING' },
        }),
      ).toBe(MAX_OUTGOING_PENDING_REQUESTS);
    });

    describe(`the ${MAX_FRIENDS}-friend limit`, () => {
      async function playerWithFriends(label: string, count: number) {
        const player = await registerUser(label);
        const friendIds = await bulkUsers(`${label}f`, count);
        await prisma.friendship.createMany({
          data: friendIds.map((f) => {
            const { low, high } = orderPair(player.userId, f);
            return { userLowId: low, userHighId: high };
          }),
        });
        return player;
      }

      it('two requests accepted at once at 199 friends: exactly one succeeds, the player ends at exactly 200', async () => {
        const u = await playerWithFriends('flim1', MAX_FRIENDS - 1);
        const [p, q] = await bulkUsers('flim1r', 2);
        const requests = [pendingRow(p, u.userId), pendingRow(q, u.userId)];
        await prisma.friendRequest.createMany({ data: requests });

        const results = await Promise.all(requests.map((r) => accept(u, r.id)));

        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(await friendshipsOf(u.userId)).toBe(MAX_FRIENDS);
        const stillPending = await prisma.friendRequest.findMany({
          where: { id: { in: requests.map((r) => r.id) }, status: 'PENDING' },
        });
        expect(stillPending).toHaveLength(1);
        expect(stillPending[0].pendingPairKey).not.toBeNull();
      });

      it('at 200 friends an accept is refused, the request stays PENDING, and the sender is not told', async () => {
        const u = await playerWithFriends('flim2', MAX_FRIENDS);
        const sender = await registerUser('flim2s');
        const row = pendingRow(sender.userId, u.userId);
        await prisma.friendRequest.create({ data: row });
        const events = await listen(sender, ['friend:request-accepted']);

        const res = await accept(u, row.id).expect(409);

        expect(res.body.message).toContain('full');
        expect(
          (
            await prisma.friendRequest.findUniqueOrThrow({
              where: { id: row.id },
            })
          ).status,
        ).toBe('PENDING');
        expect(await friendshipsOf(u.userId)).toBe(MAX_FRIENDS);
        await wait(400);
        expect(events).toEqual([]);
      });

      it('a sender at the limit cannot be accepted by someone else, and the refusal does not reveal why', async () => {
        const full = await playerWithFriends('flim3', MAX_FRIENDS);
        const other = await registerUser('flim3o');
        const row = pendingRow(full.userId, other.userId);
        await prisma.friendRequest.create({ data: row });

        const res = await accept(other, row.id).expect(409);

        expect(res.body.message).not.toMatch(/full|200|limit/i);
        expect(await friendshipsOf(other.userId)).toBe(0);
      });

      it('a crossed request at the limit is refused and the original stays PENDING', async () => {
        const u = await playerWithFriends('flim4', MAX_FRIENDS);
        const other = await registerUser('flim4o');
        const theirs = pendingRow(other.userId, u.userId);
        await prisma.friendRequest.create({ data: theirs });

        await send(u, other).expect(409);

        expect(await friendshipBetween(u.userId, other.userId)).toBe(0);
        expect(
          (
            await prisma.friendRequest.findUniqueOrThrow({
              where: { id: theirs.id },
            })
          ).status,
        ).toBe('PENDING');
      });
    });
  });

  describe('blocking integration', () => {
    it('blocking a friend removes the friendship; unblocking does not bring it back', async () => {
      const a = await registerUser('bk1a');
      const b = await registerUser('bk1b');
      await makeFriends(a, b);

      await block(a, b).expect(200);
      expect(await friendshipBetween(a.userId, b.userId)).toBe(0);
      expect((await listFriends(a).expect(200)).body.items).toEqual([]);
      expect((await listFriends(b).expect(200)).body.items).toEqual([]);

      await unblock(a, b).expect(204);
      expect(await friendshipBetween(a.userId, b.userId)).toBe(0);
      expect((await listFriends(a).expect(200)).body.items).toEqual([]);
      // They can become friends again only by a fresh request.
      await send(a, b).expect(201);
    });

    it('blocking cancels a pending request in EITHER direction and frees the pair key', async () => {
      const a = await registerUser('bk2a');
      const b = await registerUser('bk2b');
      const c = await registerUser('bk2c');
      const d = await registerUser('bk2d');
      const fromA = (await send(a, b).expect(201)).body.id as string;
      const fromC = (await send(c, d).expect(201)).body.id as string;

      await block(a, b).expect(200); // the SENDER blocks the recipient
      await block(d, c).expect(200); // the RECIPIENT blocks the sender

      for (const id of [fromA, fromC]) {
        const row = await prisma.friendRequest.findUniqueOrThrow({
          where: { id },
        });
        expect(row).toMatchObject({
          status: 'CANCELLED',
          pendingPairKey: null,
        });
        expect(row.respondedAt).not.toBeNull();
      }
      await accept(b, fromA).expect(409);
      await accept(d, fromC).expect(409);
      expect((await listRequests(b).expect(200)).body.items).toEqual([]);
      expect(await friendshipsOf(a.userId)).toBe(0);
      expect(await friendshipsOf(c.userId)).toBe(0);
    });

    it('does not touch requests or friendships with anyone else', async () => {
      const a = await registerUser('bk3a');
      const b = await registerUser('bk3b');
      const c = await registerUser('bk3c');
      const d = await registerUser('bk3d');
      await makeFriends(a, c);
      await send(d, a).expect(201);

      await block(a, b).expect(200);

      expect(await friendshipBetween(a.userId, c.userId)).toBe(1);
      expect(
        (await requestsBetween(a.userId, d.userId)).map((r) => r.status),
      ).toEqual(['PENDING']);
    });

    it('a blocked player cannot send a request, and gets exactly the 404 of a nonexistent player; the blocker gets 409', async () => {
      const blocker = await registerUser('bk4a');
      const blocked = await registerUser('bk4b');
      await block(blocker, blocked).expect(200);

      const hidden = await send(blocked, blocker).expect(404);
      const missing = await send(blocked, { userId: randomUUID() }).expect(404);
      expect(hidden.body.message).toBe(missing.body.message);
      expect(hidden.body.statusCode).toBe(missing.body.statusCode);

      const byBlocker = await send(blocker, blocked).expect(409);
      expect(byBlocker.body.message).toContain('You have blocked');
      expect(
        await requestsBetween(blocker.userId, blocked.userId),
      ).toHaveLength(0);
    });

    it('a request that slipped past a block (created concurrently with it) is refused on accept and cancelled', async () => {
      const a = await registerUser('bk5a');
      const b = await registerUser('bk5b');
      await block(b, a).expect(200);
      // What the send-vs-block race could leave behind.
      const stale = pendingRow(a.userId, b.userId);
      await prisma.friendRequest.create({ data: stale });

      const res = await accept(b, stale.id).expect(409);

      expect(res.body.message).toContain('no longer pending');
      expect(
        (
          await prisma.friendRequest.findUniqueOrThrow({
            where: { id: stale.id },
          })
        ).status,
      ).toBe('CANCELLED');
      expect(await friendshipsOf(a.userId)).toBe(0);
    });

    it('blocking leaves an active match running', async () => {
      const a = await registerUser('bk6a');
      const b = await registerUser('bk6b');
      await makeFriends(a, b);
      const challenge = await api()
        .post('/api/v1/challenges')
        .set(auth(a))
        .send({ gameId: 'tic_tac_toe', opponentUserId: b.userId })
        .expect(201);
      const accepted = await api()
        .post(`/api/v1/challenges/${challenge.body.id}/accept`)
        .set(auth(b))
        .expect(200);

      await block(a, b).expect(200);

      const match = await prisma.match.findUniqueOrThrow({
        where: { id: accepted.body.matchId },
      });
      expect(match.status).toBe('ACTIVE');
      expect(await friendshipBetween(a.userId, b.userId)).toBe(0);
    });

    it('a stale friendship across a block is hidden from the list and its presence is never read', async () => {
      const a = await registerUser('bk7a');
      const b = await registerUser('bk7b');
      const c = await registerUser('bk7c');
      await makeFriends(a, b);
      await makeFriends(a, c);
      // Inconsistent on purpose: a block row with the friendship left behind.
      await prisma.userBlock.create({
        data: { blockerId: b.userId, blockedId: a.userId },
      });
      const getMany = vi.spyOn(presenceService, 'getMany');

      const res = await listFriends(a).expect(200);

      expect(res.body.items.map((i: { userId: string }) => i.userId)).toEqual([
        c.userId,
      ]);
      expect(getMany).toHaveBeenCalledTimes(1);
      expect(getMany.mock.calls[0][0]).toEqual([c.userId]);
    });
  });

  describe('races between block and friend operations (pair lock)', () => {
    it('a send waits for the pair lock and sees a block committed while it waited', async () => {
      const a = await registerUser('rc1a');
      const b = await registerUser('rc1b');
      const lock = await holdPairLock(a, b, async (tx) => {
        await tx.userBlock.create({
          data: { blockerId: b.userId, blockedId: a.userId },
        });
      });

      const pending = send(a, b).then((r) => r);
      const blocked = await waitForBackendBlockedBy(prisma, lock.pid);
      expect(blocked[0].wait_event_type).toBe('Lock');
      expect(blocked[0].query).toMatch(/pg_advisory_xact_lock/);
      lock.release();
      await lock.held;
      const res = await pending;

      expect(res.status).toBe(404);
      expect(await requestsBetween(a.userId, b.userId)).toHaveLength(0);
    });

    it('an accept waits for the pair lock and sees a block committed while it waited: cancelled, no friendship', async () => {
      const a = await registerUser('rc2a');
      const b = await registerUser('rc2b');
      const req = (await send(a, b).expect(201)).body.id as string;
      const lock = await holdPairLock(a, b, async (tx) => {
        await tx.userBlock.create({
          data: { blockerId: a.userId, blockedId: b.userId },
        });
      });

      const pending = accept(b, req).then((r) => r);
      const blocked = await waitForBackendBlockedBy(prisma, lock.pid);
      expect(blocked[0].wait_event_type).toBe('Lock');
      lock.release();
      await lock.held;
      const res = await pending;

      expect(res.status).toBe(409);
      expect(
        (await prisma.friendRequest.findUniqueOrThrow({ where: { id: req } }))
          .status,
      ).toBe('CANCELLED');
      expect(await friendshipsOf(a.userId)).toBe(0);
    });

    it('a block waits behind an in-flight friend operation, then removes the friendship', async () => {
      const a = await registerUser('rc3a');
      const b = await registerUser('rc3b');
      await makeFriends(a, b);
      const lock = await holdPairLock(a, b);

      const pending = block(a, b).then((r) => r);
      const blocked = await waitForBackendBlockedBy(prisma, lock.pid);
      expect(blocked[0].wait_event_type).toBe('Lock');
      lock.release();
      await lock.held;
      const res = await pending;

      expect(res.status).toBe(200);
      expect(await friendshipBetween(a.userId, b.userId)).toBe(0);
    });

    it('a remove-friend waits for the pair lock too', async () => {
      const a = await registerUser('rc4a');
      const b = await registerUser('rc4b');
      await makeFriends(a, b);
      const lock = await holdPairLock(a, b);

      const pending = removeFriend(a, b).then((r) => r);
      const blocked = await waitForBackendBlockedBy(prisma, lock.pid);
      expect(blocked[0].wait_event_type).toBe('Lock');
      lock.release();
      await lock.held;

      expect((await pending).status).toBe(204);
    });

    it('a concurrent accept and block always end with no friendship and no open request', async () => {
      for (let i = 0; i < 6; i += 1) {
        const a = await registerUser(`rc5a${i}`);
        const b = await registerUser(`rc5b${i}`);
        const req = (await send(a, b).expect(201)).body.id as string;

        const [acceptRes, blockRes] = await Promise.all([
          accept(b, req),
          block(a, b),
        ]);

        expect(blockRes.status).toBe(200);
        expect([200, 409]).toContain(acceptRes.status);
        // Accept first: the friendship existed briefly and the block removed
        // it. Block first: the accept was refused. Either way:
        expect(await friendshipBetween(a.userId, b.userId)).toBe(0);
        const rows = await requestsBetween(a.userId, b.userId);
        expect(rows.every((r) => r.status !== 'PENDING')).toBe(true);
        expect(rows.every((r) => r.pendingPairKey === null)).toBe(true);
      }
    });

    it('a concurrent send and block never leave an open request or a friendship', async () => {
      for (let i = 0; i < 6; i += 1) {
        const a = await registerUser(`rc6a${i}`);
        const b = await registerUser(`rc6b${i}`);

        const [sendRes, blockRes] = await Promise.all([
          send(a, b),
          block(b, a),
        ]);

        expect(blockRes.status).toBe(200);
        expect([201, 404]).toContain(sendRes.status);
        const rows = await requestsBetween(a.userId, b.userId);
        expect(rows.every((r) => r.status !== 'PENDING')).toBe(true);
        expect(await friendshipBetween(a.userId, b.userId)).toBe(0);
      }
    });

    it('a concurrent remove-friend and send never leave two relationships', async () => {
      for (let i = 0; i < 4; i += 1) {
        const a = await registerUser(`rc7a${i}`);
        const b = await registerUser(`rc7b${i}`);
        await makeFriends(a, b);

        const [removeRes, sendRes] = await Promise.all([
          removeFriend(a, b),
          send(b, a),
        ]);

        expect(removeRes.status).toBe(204);
        expect([201, 409]).toContain(sendRes.status);
        const friends = await friendshipBetween(a.userId, b.userId);
        const open = (await requestsBetween(a.userId, b.userId)).filter(
          (r) => r.status === 'PENDING',
        );
        // Either the send ran first (refused: already friends) and the friendship
        // was then removed, or the removal ran first and a request is now open.
        // Never both a friendship and an open request.
        expect(friends + open.length).toBeLessThanOrEqual(1);
        expect(friends).toBe(0);
      }
    });
  });

  describe('presence', () => {
    it('shows a friend’s presence, and OFFLINE for a friend with none', async () => {
      const a = await registerUser('pr1a');
      const online = await registerUser('pr1b');
      const quiet = await registerUser('pr1c');
      await makeFriends(a, online);
      await makeFriends(a, quiet);
      await presenceService.set(online.userId, 'IN_MATCH');
      touchedPresence.push(online.userId);

      const res = await listFriends(a).expect(200);

      const byId = Object.fromEntries(
        res.body.items.map((i: { userId: string; presence: string }) => [
          i.userId,
          i.presence,
        ]),
      );
      expect(byId).toEqual({
        [online.userId]: 'IN_MATCH',
        [quiet.userId]: 'OFFLINE',
      });
    });

    it('never exposes the presence of someone who is not a friend, and offers no way to ask for it', async () => {
      const a = await registerUser('pr2a');
      const stranger = await registerUser('pr2s');
      await presenceService.set(stranger.userId, 'ONLINE');
      touchedPresence.push(stranger.userId);
      const getMany = vi.spyOn(presenceService, 'getMany');

      const res = await listFriends(a).expect(200);

      expect(res.body.items).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain(stranger.userId);
      expect(getMany).not.toHaveBeenCalled();
      // A caller-supplied id list is not a thing: the parameter is rejected.
      await api()
        .get(`/api/v1/friends?ids=${stranger.userId}`)
        .set(auth(a))
        .expect(400);
      await api()
        .get(`/api/v1/friends/presence?ids=${stranger.userId}`)
        .set(auth(a))
        .expect((r) => expect([400, 404]).toContain(r.status));
    });

    it('hides presence across a blocked pair', async () => {
      const a = await registerUser('pr3a');
      const b = await registerUser('pr3b');
      await makeFriends(a, b);
      await presenceService.set(b.userId, 'ONLINE');
      touchedPresence.push(b.userId);
      await prisma.userBlock.create({
        data: { blockerId: a.userId, blockedId: b.userId },
      });

      const res = await listFriends(a).expect(200);

      expect(res.body.items).toEqual([]);
    });

    it('reads every friend’s presence with ONE batch call', async () => {
      const a = await registerUser('pr4a');
      const friends = [await registerUser('pr4b'), await registerUser('pr4c')];
      for (const f of friends) await makeFriends(a, f);
      const getMany = vi.spyOn(presenceService, 'getMany');
      const getOne = vi.spyOn(presenceService, 'get');

      await listFriends(a).expect(200);

      expect(getMany).toHaveBeenCalledTimes(1);
      expect([...getMany.mock.calls[0][0]].sort()).toEqual(
        friends.map((f) => f.userId).sort(),
      );
      expect(getOne).not.toHaveBeenCalled();
    });

    it('answers OFFLINE (not an error) if Redis fails', async () => {
      const a = await registerUser('pr5a');
      const b = await registerUser('pr5b');
      await makeFriends(a, b);
      await presenceService.set(b.userId, 'ONLINE');
      touchedPresence.push(b.userId);
      vi.spyOn(presenceService, 'getMany').mockRejectedValueOnce(
        new Error('Redis is down'),
      );

      const res = await listFriends(a).expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        userId: b.userId,
        presence: 'OFFLINE',
      });
    });
  });

  describe('realtime notifications', () => {
    it('friend:request-received reaches only the recipient, with a minimal payload', async () => {
      const sender = await registerUser('rt1s');
      const recipient = await registerUser('rt1r');
      const bystander = await registerUser('rt1x');
      const atRecipient = await listen(recipient, [
        'friend:request-received',
        'friend:request-accepted',
      ]);
      const atBystander = await listen(bystander, [
        'friend:request-received',
        'friend:request-accepted',
      ]);
      const atSender = await listen(sender, [
        'friend:request-received',
        'friend:request-accepted',
      ]);

      const sent = await send(sender, recipient).expect(201);
      await waitForEventCount(atRecipient, 1);
      await wait(300);

      expect(atRecipient).toEqual([
        {
          event: 'friend:request-received',
          payload: {
            requestId: sent.body.id,
            from: {
              id: sender.userId,
              username: sender.username,
              displayName: null,
            },
          },
        },
      ]);
      expect(atBystander).toEqual([]);
      expect(atSender).toEqual([]);
      expect(JSON.stringify(atRecipient)).not.toMatch(
        /example\.com|email|phone|wallet|role/i,
      );
    });

    it('friend:request-accepted reaches only the original sender, with a minimal payload', async () => {
      const sender = await registerUser('rt2s');
      const recipient = await registerUser('rt2r');
      const bystander = await registerUser('rt2x');
      const sent = await send(sender, recipient).expect(201);
      const atSender = await listen(sender, [
        'friend:request-received',
        'friend:request-accepted',
      ]);
      const atRecipient = await listen(recipient, [
        'friend:request-received',
        'friend:request-accepted',
      ]);
      const atBystander = await listen(bystander, [
        'friend:request-received',
        'friend:request-accepted',
      ]);

      await accept(recipient, sent.body.id).expect(200);
      await waitForEventCount(atSender, 1);
      await wait(300);

      expect(atSender).toEqual([
        {
          event: 'friend:request-accepted',
          payload: {
            requestId: sent.body.id,
            friend: {
              id: recipient.userId,
              username: recipient.username,
              displayName: null,
            },
          },
        },
      ]);
      expect(atRecipient).toEqual([]);
      expect(atBystander).toEqual([]);
    });

    it('a crossed request tells the original sender it was accepted, and nobody gets a "received"', async () => {
      const a = await registerUser('rt3a');
      const b = await registerUser('rt3b');
      const first = await send(b, a).expect(201);
      const atB = await listen(b, [
        'friend:request-received',
        'friend:request-accepted',
      ]);
      const atA = await listen(a, [
        'friend:request-received',
        'friend:request-accepted',
      ]);

      await send(a, b).expect(201);
      await waitForEventCount(atB, 1);
      await wait(300);

      expect(atB.map((e) => e.event)).toEqual(['friend:request-accepted']);
      expect((atB[0].payload as { requestId: string }).requestId).toBe(
        first.body.id,
      );
      expect(atA).toEqual([]);
    });

    it('nothing is emitted for a refused send, decline or cancel', async () => {
      const a = await registerUser('rt4a');
      const b = await registerUser('rt4b');
      const atB = await listen(b, [
        'friend:request-received',
        'friend:request-accepted',
      ]);
      const atA = await listen(a, [
        'friend:request-received',
        'friend:request-accepted',
      ]);
      await send(a, a).expect(400);
      await block(b, a).expect(200);
      await send(a, b).expect(404);

      await wait(400);

      expect(atA).toEqual([]);
      expect(atB).toEqual([]);
    });

    it('rejects a socket with no token, so a private event can never reach an unauthenticated listener', async () => {
      const socket = io(baseUrl, { transports: ['websocket'], forceNew: true });
      sockets.push(socket);
      const received: unknown[] = [];
      socket.on('friend:request-received', (p: unknown) => received.push(p));
      await new Promise<void>((resolve) => {
        socket.once('disconnect', () => resolve());
        socket.once('connect_error', () => resolve());
      });
      const a = await registerUser('rt5a');
      const b = await registerUser('rt5b');

      await send(a, b).expect(201);
      await wait(300);

      expect(received).toEqual([]);
      expect(socket.connected).toBe(false);
    });
  });
});
