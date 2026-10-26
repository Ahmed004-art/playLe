import { randomUUID } from 'node:crypto';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Phase 12 PR 2 - public profiles, summaries, match statistics and the
 * block-aware username lookup (see docs/decisions/ADR-026-social-foundation.md).
 * Mirrors the harness conventions of the other e2e suites. Runs in CI only: it
 * needs Postgres and Redis. The statistics cases write `matches` rows directly
 * so every stored outcome (including the inconsistent ones the API itself can
 * never produce) is exercised against the real SQL.
 */
describe('Player profiles, summaries and lookup (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const runId = randomUUID().slice(0, 8);

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
    await app.init();

    prisma = moduleFixture.get(PrismaService);
  }, 30000);

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

  const auth = (p: Player) => ({ Authorization: `Bearer ${p.accessToken}` });

  const profile = (viewer: Player, id: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/users/${id}/profile`)
      .set(auth(viewer));

  const summaries = (viewer: Player, ids?: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/users/summaries${ids === undefined ? '' : `?ids=${ids}`}`)
      .set(auth(viewer));

  const lookup = (viewer: Player, name: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/users/lookup?username=${encodeURIComponent(name)}`)
      .set(auth(viewer));

  const block = (by: Player, target: Player) =>
    request(app.getHttpServer())
      .post('/api/v1/blocks')
      .set(auth(by))
      .send({ userId: target.userId })
      .expect(200);

  type StoredMatch = {
    status: 'COMPLETED' | 'ABANDONED' | 'CANCELLED' | 'ACTIVE' | 'WAITING';
    players: Player[];
    winner?: Player | null;
    isDraw?: boolean;
    reason?:
      | 'ABANDONED_DISCONNECT'
      | 'WAITING_TIMEOUT'
      | 'RESIGNATION'
      | 'DRAW_AGREED';
  };

  /** Writes a match row exactly as stored, however odd. */
  function storeMatch(m: StoredMatch) {
    return prisma.match.create({
      data: {
        gameId: 'tic_tac_toe',
        gameVersion: 1,
        status: m.status,
        state: {},
        winnerUserId: m.winner?.userId ?? null,
        resultIsDraw: m.isDraw ?? false,
        terminationReason: m.reason ?? null,
        players: {
          create: m.players.map((p, seat) => ({ userId: p.userId, seat })),
        },
      },
    });
  }

  describe('GET /users/:id/profile', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/users/${randomUUID()}/profile`)
        .expect(401);
    });

    it('rejects a malformed id (400) and a well-formed unknown id (404)', async () => {
      const viewer = await registerUser('pf1v');

      await profile(viewer, 'not-a-uuid').expect(400);
      await profile(viewer, randomUUID()).expect(404);
    });

    it('returns exactly the public fields and no private data', async () => {
      const viewer = await registerUser('pf2v');
      const other = await registerUser('pf2o');
      await prisma.user.update({
        where: { id: other.userId },
        data: { displayName: 'Other Person', phoneNumber: `+2327${runId}` },
      });

      const res = await profile(viewer, other.userId).expect(200);

      expect(res.body).toEqual({
        id: other.userId,
        username: other.username,
        displayName: 'Other Person',
        gamesPlayed: 0,
        wins: 0,
        losses: 0,
        draws: 0,
      });
      const json = JSON.stringify(res.body);
      for (const secret of [
        '@example.com',
        `+2327${runId}`,
        '2000-01-01',
        'passwordHash',
        'USER',
        'ACTIVE',
        'wallet',
        'role',
        'email',
        'dateOfBirth',
        'status',
      ]) {
        expect(json).not.toContain(secret);
      }
    });

    it('lets a player open their own profile', async () => {
      const me = await registerUser('pf3');

      const res = await profile(me, me.userId).expect(200);

      expect(res.body.id).toBe(me.userId);
    });

    it('404s for a player who is not ACTIVE', async () => {
      const viewer = await registerUser('pf4v');
      const other = await registerUser('pf4o');
      await prisma.user.update({
        where: { id: other.userId },
        data: { status: 'SUSPENDED' },
      });

      await profile(viewer, other.userId).expect(404);
    });

    it('a player who blocked the viewer looks exactly like a nonexistent player; the blocker can still look', async () => {
      const viewer = await registerUser('pf5v');
      const blocker = await registerUser('pf5b');
      await block(blocker, viewer);

      const hidden = await profile(viewer, blocker.userId).expect(404);
      const missing = await profile(viewer, randomUUID()).expect(404);
      expect(hidden.body.message).toBe(missing.body.message);
      expect(hidden.body.statusCode).toBe(missing.body.statusCode);

      // The blocker is not hidden from: they can open the player they blocked.
      await profile(blocker, viewer.userId).expect(200);
    });

    it('lets an unblocked player through again', async () => {
      const viewer = await registerUser('pf6v');
      const blocker = await registerUser('pf6b');
      await block(blocker, viewer);
      await profile(viewer, blocker.userId).expect(404);

      await request(app.getHttpServer())
        .delete(`/api/v1/blocks/${viewer.userId}`)
        .set(auth(blocker))
        .expect(204);

      await profile(viewer, blocker.userId).expect(200);
    });
  });

  describe('match statistics', () => {
    it('counts only COMPLETED matches whose stored result is consistent', async () => {
      const x = await registerUser('st1x');
      const y = await registerUser('st1y');
      const z = await registerUser('st1z');
      const viewer = await registerUser('st1v');

      // Counted for x.
      await storeMatch({ status: 'COMPLETED', players: [x, y], winner: x }); // win
      await storeMatch({ status: 'COMPLETED', players: [x, y], winner: y }); // loss
      await storeMatch({
        status: 'COMPLETED',
        players: [x, y],
        isDraw: true,
        reason: 'DRAW_AGREED',
      }); // draw

      // Never counted.
      await storeMatch({ status: 'COMPLETED', players: [x, y] }); // no winner, not a draw
      await storeMatch({
        status: 'COMPLETED',
        players: [x, y],
        winner: x,
        isDraw: true,
      }); // a draw that also names a winner
      await storeMatch({ status: 'COMPLETED', players: [x, y], winner: z }); // winner is not a player
      await storeMatch({
        status: 'ABANDONED',
        players: [x, y],
        winner: x,
        reason: 'ABANDONED_DISCONNECT',
      }); // disconnect forfeit
      await storeMatch({
        status: 'CANCELLED',
        players: [x, y],
        reason: 'WAITING_TIMEOUT',
      });
      await storeMatch({ status: 'ACTIVE', players: [x, y] });
      await storeMatch({ status: 'WAITING', players: [x, y] });
      await storeMatch({ status: 'COMPLETED', players: [y, z], winner: x }); // x is not a player

      const forX = await profile(viewer, x.userId).expect(200);
      expect(forX.body).toMatchObject({
        gamesPlayed: 3,
        wins: 1,
        losses: 1,
        draws: 1,
      });

      // The same matches seen from the other seat.
      const forY = await profile(viewer, y.userId).expect(200);
      expect(forY.body).toMatchObject({
        gamesPlayed: 3,
        wins: 1,
        losses: 1,
        draws: 1,
      });

      // z only appears as a stray winner/player in rows that must not count.
      const forZ = await profile(viewer, z.userId).expect(200);
      expect(forZ.body).toMatchObject({
        gamesPlayed: 0,
        wins: 0,
        losses: 0,
        draws: 0,
      });
    });

    it('a disconnect-only forfeit never makes a winner or a loser', async () => {
      const a = await registerUser('st2a');
      const b = await registerUser('st2b');
      const viewer = await registerUser('st2v');
      await storeMatch({
        status: 'ABANDONED',
        players: [a, b],
        winner: b,
        reason: 'ABANDONED_DISCONNECT',
      });

      for (const p of [a, b]) {
        const res = await profile(viewer, p.userId).expect(200);
        expect(res.body).toMatchObject({
          gamesPlayed: 0,
          wins: 0,
          losses: 0,
          draws: 0,
        });
      }
    });

    it('the database makes duplicate match-player rows impossible', async () => {
      const a = await registerUser('st3a');
      const match = await storeMatch({
        status: 'COMPLETED',
        players: [a],
        winner: a,
      });

      await expect(
        prisma.matchPlayer.create({
          data: { matchId: match.id, userId: a.userId, seat: 1 },
        }),
      ).rejects.toThrow();

      const res = await profile(a, a.userId).expect(200);
      expect(res.body).toMatchObject({ gamesPlayed: 1, wins: 1 });
    });

    it('does not count a challenge or a match that has only just started', async () => {
      const a = await registerUser('st4a');
      const b = await registerUser('st4b');
      const viewer = await registerUser('st4v');
      const challenge = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set(auth(a))
        .send({ gameId: 'tic_tac_toe', opponentUserId: b.userId })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/accept`)
        .set(auth(b))
        .expect(200);

      // An ACTIVE match now exists between them: not a completed result.
      for (const p of [a, b]) {
        const res = await profile(viewer, p.userId).expect(200);
        expect(res.body.gamesPlayed).toBe(0);
      }
    });

    it('counts a real resignation: the resigner loses, the opponent wins', async () => {
      const a = await registerUser('st5a');
      const b = await registerUser('st5b');
      const viewer = await registerUser('st5v');
      const challenge = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set(auth(a))
        .send({ gameId: 'tic_tac_toe', opponentUserId: b.userId })
        .expect(201);
      const accepted = await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/accept`)
        .set(auth(b))
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/matches/${accepted.body.matchId}/commands`)
        .set(auth(a))
        .send({ commandId: randomUUID(), type: 'RESIGN', payload: {} })
        .expect(200);

      const forA = await profile(viewer, a.userId).expect(200);
      const forB = await profile(viewer, b.userId).expect(200);

      expect(forA.body).toMatchObject({
        gamesPlayed: 1,
        wins: 0,
        losses: 1,
        draws: 0,
      });
      expect(forB.body).toMatchObject({
        gamesPlayed: 1,
        wins: 1,
        losses: 0,
        draws: 0,
      });
    });
  });

  describe('GET /users/summaries', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/users/summaries?ids=${randomUUID()}`)
        .expect(401);
    });

    it('treats absent and empty ids as an empty list', async () => {
      const viewer = await registerUser('sm1');

      const absent = await summaries(viewer).expect(200);
      const empty = await summaries(viewer, '').expect(200);

      expect(absent.body).toEqual({ items: [] });
      expect(empty.body).toEqual({ items: [] });
    });

    it('rejects malformed ids and more than 50 unique ids with 400', async () => {
      const viewer = await registerUser('sm2');
      const fifty = Array.from({ length: 50 }, () => randomUUID());

      await summaries(viewer, 'not-a-uuid').expect(400);
      await summaries(viewer, `${randomUUID()},,${randomUUID()}`).expect(400);
      await summaries(viewer, `${randomUUID()},nope`).expect(400);
      await summaries(viewer, [...fifty, randomUUID()].join(',')).expect(400);

      // Exactly 50 unique is fine, and duplicates never count towards the limit.
      const ok = await summaries(viewer, fifty.join(',')).expect(200);
      expect(ok.body).toEqual({ items: [] });
      await summaries(viewer, [...fifty, ...fifty, fifty[0]].join(',')).expect(
        200,
      );
    });

    it('returns only id, username and display name, once per player, in request order', async () => {
      const viewer = await registerUser('sm3v');
      const a = await registerUser('sm3a');
      const b = await registerUser('sm3b');
      await prisma.user.update({
        where: { id: a.userId },
        data: { displayName: 'Ay' },
      });

      const res = await summaries(
        viewer,
        `${b.userId},${a.userId},${b.userId.toUpperCase()}`,
      ).expect(200);

      expect(res.body.items).toEqual([
        { id: b.userId, username: b.username, displayName: null },
        { id: a.userId, username: a.username, displayName: 'Ay' },
      ]);
      expect(JSON.stringify(res.body)).not.toContain('@example.com');
    });

    it('hides players in both block directions, and nonexistent or inactive ones, without any marker', async () => {
      const viewer = await registerUser('sm4v');
      const iBlocked = await registerUser('sm4a');
      const blockedMe = await registerUser('sm4b');
      const both = await registerUser('sm4c');
      const normal = await registerUser('sm4d');
      const inactive = await registerUser('sm4e');
      await block(viewer, iBlocked);
      await block(blockedMe, viewer);
      await block(viewer, both);
      await block(both, viewer);
      await prisma.user.update({
        where: { id: inactive.userId },
        data: { status: 'DISABLED' },
      });

      const res = await summaries(
        viewer,
        [
          iBlocked,
          blockedMe,
          both,
          normal,
          inactive,
          { userId: randomUUID() },
          viewer,
        ]
          .map((p) => p.userId)
          .join(','),
      ).expect(200);

      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([
        normal.userId,
        viewer.userId,
      ]);
    });

    it('a hidden player is indistinguishable from a nonexistent one', async () => {
      const viewer = await registerUser('sm5v');
      const hidden = await registerUser('sm5h');
      await block(hidden, viewer);

      const hiddenRes = await summaries(viewer, hidden.userId).expect(200);
      const missingRes = await summaries(viewer, randomUUID()).expect(200);

      expect(hiddenRes.body).toEqual(missingRes.body);
      expect(hiddenRes.status).toBe(missingRes.status);
    });

    it('shows a player again once the block is lifted', async () => {
      const viewer = await registerUser('sm6v');
      const other = await registerUser('sm6o');
      await block(viewer, other);
      expect(
        (await summaries(viewer, other.userId).expect(200)).body.items,
      ).toEqual([]);

      await request(app.getHttpServer())
        .delete(`/api/v1/blocks/${other.userId}`)
        .set(auth(viewer))
        .expect(204);

      const res = await summaries(viewer, other.userId).expect(200);
      expect(res.body.items).toHaveLength(1);
    });
  });

  describe('GET /users/lookup is block-aware', () => {
    it('resolves a normal player exactly as before', async () => {
      const viewer = await registerUser('lk1v');
      const other = await registerUser('lk1o');

      const res = await lookup(viewer, other.username).expect(200);

      expect(res.body).toEqual({ id: other.userId, username: other.username });
    });

    it('resolves the viewer themselves', async () => {
      const me = await registerUser('lk2');

      expect((await lookup(me, me.username).expect(200)).body.id).toBe(
        me.userId,
      );
    });

    it('a player who blocked the viewer looks exactly like an unknown username', async () => {
      const viewer = await registerUser('lk3v');
      const blocker = await registerUser('lk3b');
      await block(blocker, viewer);

      const hidden = await lookup(viewer, blocker.username).expect(404);
      const missing = await lookup(viewer, `ghost${runId}`).expect(404);

      expect(hidden.body.message).toBe(missing.body.message);
      expect(hidden.body.statusCode).toBe(missing.body.statusCode);
    });

    it('a blocker can still resolve the player they blocked', async () => {
      const blocker = await registerUser('lk4b');
      const blocked = await registerUser('lk4x');
      await block(blocker, blocked);

      const res = await lookup(blocker, blocked.username).expect(200);

      expect(res.body.id).toBe(blocked.userId);
    });

    it('when both blocked each other, neither can resolve the other', async () => {
      const a = await registerUser('lk5a');
      const b = await registerUser('lk5b');
      await block(a, b);
      await block(b, a);

      await lookup(a, b.username).expect(404);
      await lookup(b, a.username).expect(404);
    });

    it('still 404s for an unknown username and for a missing parameter', async () => {
      const viewer = await registerUser('lk6');

      await lookup(viewer, `ghost${runId}`).expect(404);
      await request(app.getHttpServer())
        .get('/api/v1/users/lookup')
        .set(auth(viewer))
        .expect(404);
    });
  });
});
