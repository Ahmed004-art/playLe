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
import { lockUserPair } from '../src/blocks/pair-lock.js';
import { waitForBackendBlockedBy } from './pg-locks.js';

/**
 * Phase 12 PR 1 - player blocking and its enforcement in challenge creation
 * and acceptance (see docs/decisions/ADR-026-social-foundation.md). Mirrors
 * the harness conventions of the other e2e suites. Runs in CI only: it needs
 * Postgres and Redis.
 */
describe('Blocking (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const runId = randomUUID().slice(0, 8);

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

  type Player = { accessToken: string; userId: string };

  const auth = (p: Player) => ({ Authorization: `Bearer ${p.accessToken}` });

  const block = (by: Player, target: Player) =>
    request(app.getHttpServer())
      .post('/api/v1/blocks')
      .set(auth(by))
      .send({ userId: target.userId });

  const unblock = (by: Player, target: Player) =>
    request(app.getHttpServer())
      .delete(`/api/v1/blocks/${target.userId}`)
      .set(auth(by));

  const challenge = (from: Player, to: Player, gameId = 'tic_tac_toe') =>
    request(app.getHttpServer())
      .post('/api/v1/challenges')
      .set(auth(from))
      .send({ gameId, opponentUserId: to.userId });

  const accept = (by: Player, challengeId: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/challenges/${challengeId}/accept`)
      .set(auth(by));

  const openMatchesFor = (userId: string) =>
    prisma.matchPlayer.count({
      where: {
        userId,
        match: { status: { in: ['WAITING', 'READY', 'ACTIVE'] } },
      },
    });

  describe('block / unblock / list', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/v1/blocks').expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/blocks')
        .send({ userId: randomUUID() })
        .expect(401);
    });

    it('blocks a player, is idempotent, and lists only the caller’s own blocks', async () => {
      const a = await registerUser('blk1a');
      const b = await registerUser('blk1b');

      const first = await block(a, b).expect(200);
      expect(first.body).toMatchObject({ userId: b.userId });
      expect(first.body.blockedAt).toBeDefined();
      await block(a, b).expect(200);

      const mine = await request(app.getHttpServer())
        .get('/api/v1/blocks')
        .set(auth(a))
        .expect(200);
      expect(mine.body.items.map((i: { userId: string }) => i.userId)).toEqual([
        b.userId,
      ]);

      // The blocked player's list does not reveal the block.
      const theirs = await request(app.getHttpServer())
        .get('/api/v1/blocks')
        .set(auth(b))
        .expect(200);
      expect(theirs.body.items).toEqual([]);
      expect(
        await prisma.userBlock.count({
          where: { blockerId: a.userId, blockedId: b.userId },
        }),
      ).toBe(1);
    });

    it('rejects blocking yourself (400), an unknown player (404) and a malformed id (400)', async () => {
      const a = await registerUser('blk2a');

      await block(a, a).expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/blocks')
        .set(auth(a))
        .send({ userId: randomUUID() })
        .expect(404);
      await request(app.getHttpServer())
        .post('/api/v1/blocks')
        .set(auth(a))
        .send({ userId: 'not-a-uuid' })
        .expect(400);
    });

    it('the database refuses a self-block even if the service were bypassed', async () => {
      const a = await registerUser('blk3a');

      await expect(
        prisma.userBlock.create({
          data: { blockerId: a.userId, blockedId: a.userId },
        }),
      ).rejects.toThrow();
    });

    it('unblock is idempotent (204 even when there is no block) and removes only the caller’s own direction', async () => {
      const a = await registerUser('blk4a');
      const b = await registerUser('blk4b');

      await unblock(a, b).expect(204);

      await block(a, b).expect(200);
      await block(b, a).expect(200);
      await unblock(a, b).expect(204);

      // b's block on a is untouched, and is still enforced both ways.
      expect(
        await prisma.userBlock.count({
          where: { blockerId: b.userId, blockedId: a.userId },
        }),
      ).toBe(1);
      expect(
        await prisma.userBlock.count({
          where: { blockerId: a.userId, blockedId: b.userId },
        }),
      ).toBe(0);
      await challenge(a, b).expect(404);
      await challenge(b, a).expect(409);
    });

    it('pages through blocks with a cursor', async () => {
      const a = await registerUser('blk5a');
      const targets = [
        await registerUser('blk5b'),
        await registerUser('blk5c'),
        await registerUser('blk5d'),
      ];
      for (const t of targets) await block(a, t).expect(200);

      const page1 = await request(app.getHttpServer())
        .get('/api/v1/blocks?limit=2')
        .set(auth(a))
        .expect(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.nextCursor).not.toBeNull();

      const page2 = await request(app.getHttpServer())
        .get(`/api/v1/blocks?limit=2&cursor=${page1.body.nextCursor}`)
        .set(auth(a))
        .expect(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();

      const seen = [...page1.body.items, ...page2.body.items].map(
        (i: { userId: string }) => i.userId,
      );
      expect(new Set(seen)).toEqual(new Set(targets.map((t) => t.userId)));
    });
  });

  describe('challenge creation', () => {
    it('is directional: the blocker gets 409, the blocked player gets the same 404 as a missing player, a third party is unaffected', async () => {
      const a = await registerUser('cc1a');
      const b = await registerUser('cc1b');
      const c = await registerUser('cc1c');
      await block(a, b).expect(200);

      const byBlocker = await challenge(a, b).expect(409);
      expect(byBlocker.body.message).toContain('You have blocked this player');

      const byBlocked = await challenge(b, a).expect(404);
      expect(byBlocked.body.message).toContain('Opponent not found');
      const missing = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set(auth(b))
        .send({ gameId: 'tic_tac_toe', opponentUserId: randomUUID() })
        .expect(404);
      expect(byBlocked.body.message).toBe(missing.body.message);

      await challenge(c, a).expect(201);
    });

    it('works again in both directions after unblocking', async () => {
      const a = await registerUser('cc2a');
      const b = await registerUser('cc2b');
      await block(a, b).expect(200);
      await challenge(b, a).expect(404);

      await unblock(a, b).expect(204);

      await challenge(b, a).expect(201);
    });
  });

  describe('pending challenges', () => {
    it('are cancelled in both directions when a block is placed, and unrelated challenges survive', async () => {
      const a = await registerUser('pc1a');
      const b = await registerUser('pc1b');
      const c = await registerUser('pc1c');

      const aToB = await challenge(a, b).expect(201);
      const bToA = await challenge(b, a, 'checkers').expect(201);
      const cToA = await challenge(c, a).expect(201);

      await block(a, b).expect(200);

      const statuses = await prisma.challenge.findMany({
        where: { id: { in: [aToB.body.id, bToA.body.id, cToA.body.id] } },
        select: { id: true, status: true },
      });
      const byId = Object.fromEntries(statuses.map((s) => [s.id, s.status]));
      expect(byId[aToB.body.id]).toBe('CANCELLED');
      expect(byId[bToA.body.id]).toBe('CANCELLED');
      expect(byId[cToA.body.id]).toBe('PENDING');

      // A cancelled challenge cannot be accepted, and no match forms.
      await accept(b, aToB.body.id).expect(409);
      expect(await openMatchesFor(a.userId)).toBe(0);
      expect(await openMatchesFor(b.userId)).toBe(0);
    });

    it('stay cancelled when the block is lifted', async () => {
      const a = await registerUser('pc2a');
      const b = await registerUser('pc2b');
      const aToB = await challenge(a, b).expect(201);
      await block(a, b).expect(200);

      await unblock(a, b).expect(204);

      const row = await prisma.challenge.findUniqueOrThrow({
        where: { id: aToB.body.id },
      });
      expect(row.status).toBe('CANCELLED');
      await accept(b, aToB.body.id).expect(409);
    });

    it('a PENDING challenge that slipped past a block (created concurrently with it) is refused on accept and cancelled', async () => {
      const a = await registerUser('pc3a');
      const b = await registerUser('pc3b');
      await block(a, b).expect(200);
      // What the create-vs-block race leaves behind: a PENDING row alongside
      // an existing block. The API itself refuses to create it.
      const stale = await prisma.challenge.create({
        data: {
          gameId: 'tic_tac_toe',
          challengerId: b.userId,
          opponentId: a.userId,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const res = await accept(a, stale.id).expect(409);
      expect(res.body.message).toContain('no longer pending');

      const row = await prisma.challenge.findUniqueOrThrow({
        where: { id: stale.id },
      });
      expect(row.status).toBe('CANCELLED');
      expect(await openMatchesFor(a.userId)).toBe(0);
    });

    it('a match that already exists is untouched by a later block', async () => {
      const a = await registerUser('pc4a');
      const b = await registerUser('pc4b');
      const created = await challenge(a, b).expect(201);
      const accepted = await accept(b, created.body.id).expect(200);

      await block(a, b).expect(200);

      const match = await prisma.match.findUniqueOrThrow({
        where: { id: accepted.body.matchId },
      });
      expect(['WAITING', 'READY', 'ACTIVE']).toContain(match.status);
    });
  });

  describe('races (block vs challenge accept)', () => {
    /**
     * Holds the pair lock in a test-owned transaction, standing in for
     * whichever of block/accept is "first", and returns a handle to release
     * it. While held, the request under test must wait on it.
     */
    async function holdPairLock(
      a: Player,
      b: Player,
      whileHeld: (tx: PrismaService) => Promise<void> = () => Promise.resolve(),
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
          await whileHeld(tx as unknown as PrismaService);
        },
        { maxWait: 10_000, timeout: 20_000 },
      );
      await ready;
      return { pid, release, held };
    }

    it('an accept waits for the pair lock, and sees a block committed while it waited', async () => {
      const a = await registerUser('rc1a');
      const b = await registerUser('rc1b');
      const created = await challenge(a, b).expect(201);

      const lock = await holdPairLock(a, b, async (tx) => {
        await tx.userBlock.create({
          data: { blockerId: a.userId, blockedId: b.userId },
        });
      });
      const pending = accept(b, created.body.id).then((r) => r);
      const blocked = await waitForBackendBlockedBy(prisma, lock.pid);
      expect(blocked[0].wait_event_type).toBe('Lock');
      expect(blocked[0].query).toMatch(/pg_advisory_xact_lock/);

      lock.release();
      await lock.held;
      const res = await pending;

      expect(res.status).toBe(409);
      const row = await prisma.challenge.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(row.status).toBe('CANCELLED');
      expect(await openMatchesFor(a.userId)).toBe(0);
    });

    it('a block waits for the pair lock behind an in-flight accept, then cancels the pending challenge', async () => {
      const a = await registerUser('rc2a');
      const b = await registerUser('rc2b');
      const created = await challenge(a, b).expect(201);

      const lock = await holdPairLock(a, b);
      const pending = block(a, b).then((r) => r);
      const blocked = await waitForBackendBlockedBy(prisma, lock.pid);
      expect(blocked[0].wait_event_type).toBe('Lock');

      lock.release();
      await lock.held;
      const res = await pending;

      expect(res.status).toBe(200);
      const row = await prisma.challenge.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(row.status).toBe('CANCELLED');
    });

    it('a concurrent accept and block always resolve consistently: a running match and an untouched ACCEPTED challenge, or no match and a CANCELLED one', async () => {
      for (let i = 0; i < 6; i += 1) {
        const a = await registerUser(`rc3a${i}`);
        const b = await registerUser(`rc3b${i}`);
        const created = await challenge(a, b).expect(201);

        const [acceptRes, blockRes] = await Promise.all([
          accept(b, created.body.id),
          block(a, b),
        ]);

        expect(blockRes.status).toBe(200);
        const row = await prisma.challenge.findUniqueOrThrow({
          where: { id: created.body.id },
        });
        expect(row.status).not.toBe('PENDING');
        if (acceptRes.status === 200) {
          expect(row.status).toBe('ACCEPTED');
          expect(row.matchId).not.toBeNull();
          expect(await openMatchesFor(a.userId)).toBe(1);
        } else {
          expect(acceptRes.status).toBe(409);
          expect(row.status).toBe('CANCELLED');
          expect(row.matchId).toBeNull();
          expect(await openMatchesFor(a.userId)).toBe(0);
        }
      }
    });
  });
});
