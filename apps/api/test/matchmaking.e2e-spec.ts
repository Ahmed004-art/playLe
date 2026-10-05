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
import { RedisService } from '../src/redis/redis.service.js';

describe('Matchmaking (e2e, real Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redisService: RedisService;
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
    redisService = moduleFixture.get(RedisService);

    const healthy = await redisService.isHealthy();
    if (!healthy) {
      throw new Error(
        'Redis is not reachable — matchmaking e2e tests require a real Redis instance (see docs/development/SETUP.md).',
      );
    }
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
    await prisma.withdrawal.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.deposit.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });

    const redis = redisService.getClient();
    for (const userId of userIds) {
      await redis.hdel('matchmaking:queued-users', userId);
    }
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

  function join(accessToken: string) {
    return request(app.getHttpServer())
      .post('/api/v1/matchmaking/join')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ gameId: 'tic_tac_toe' });
  }

  function leave(accessToken: string) {
    return request(app.getHttpServer())
      .post('/api/v1/matchmaking/leave')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ gameId: 'tic_tac_toe' });
  }

  it('queues a lone player with no match yet', async () => {
    const a = await registerUser('mmlone');
    const res = await join(a.accessToken).expect(200);
    expect(res.body.status).toBe('QUEUED');
    await leave(a.accessToken).expect(204);
  });

  it('404s for matchmaking against an unknown/invalid game id', async () => {
    const a = await registerUser('mmbadgame');
    await request(app.getHttpServer())
      .post('/api/v1/matchmaking/join')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ gameId: 'not_a_real_game' })
      .expect(404);
  });

  it('matches two sequential joiners and creates a real ACTIVE match', async () => {
    const a = await registerUser('mmseqa');
    const b = await registerUser('mmseqb');

    const first = await join(a.accessToken).expect(200);
    expect(first.body.status).toBe('QUEUED');

    const second = await join(b.accessToken).expect(200);
    expect(second.body.status).toBe('MATCHED');
    expect(second.body.matchId).toBeTruthy();

    const match = await prisma.match.findUnique({
      where: { id: second.body.matchId },
      include: { players: true },
    });
    expect(match?.status).toBe('ACTIVE');
    expect(match?.players.map((p) => p.userId).sort()).toEqual(
      [a.userId, b.userId].sort(),
    );
  });

  it('rejects joining the queue twice', async () => {
    const a = await registerUser('mmdupe');
    await join(a.accessToken).expect(200);
    await join(a.accessToken).expect(409);
    await leave(a.accessToken).expect(204);
  });

  it('rejects joining matchmaking while already in an active match', async () => {
    const a = await registerUser('mmbusya');
    const b = await registerUser('mmbusyb');

    const challenge = await request(app.getHttpServer())
      .post('/api/v1/challenges')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ gameId: 'tic_tac_toe', opponentUserId: b.userId })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/challenges/${challenge.body.id}/accept`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);

    await join(a.accessToken).expect(409);
  });

  it('leave removes a queued player — no match forms for them afterward', async () => {
    const a = await registerUser('mmleavea');
    const b = await registerUser('mmleaveb');

    await join(a.accessToken).expect(200);
    await leave(a.accessToken).expect(204);

    const second = await join(b.accessToken).expect(200);
    // b is now alone in the queue (a left), so no match should form yet.
    expect(second.body.status).toBe('QUEUED');
    await leave(b.accessToken).expect(204);
  });

  it('leave is idempotent when not queued', async () => {
    const a = await registerUser('mmleaveidem');
    await leave(a.accessToken).expect(204);
    await leave(a.accessToken).expect(204);
  });

  it(
    'never forms duplicate or overlapping matches under concurrent joins ' +
      '(4 players, 2 pairs, fired simultaneously)',
    async () => {
      const players = await Promise.all([
        registerUser('mmracea'),
        registerUser('mmraceb'),
        registerUser('mmracec'),
        registerUser('mmraced'),
      ]);

      const responses = await Promise.all(
        players.map((p) => join(p.accessToken)),
      );
      for (const res of responses) {
        expect(res.status).toBe(200);
      }

      const matches = await prisma.match.findMany({
        where: {
          players: { some: { userId: { in: players.map((p) => p.userId) } } },
        },
        include: { players: true },
      });

      // Exactly 2 matches formed (4 players / 2 per match), each with
      // exactly 2 distinct players, and every player appears in exactly
      // one match — no duplicates, no overlaps, no player left stranded.
      expect(matches).toHaveLength(2);
      const allMatchedUserIds = matches.flatMap((m) =>
        m.players.map((p) => p.userId),
      );
      expect(allMatchedUserIds.sort()).toEqual(
        players.map((p) => p.userId).sort(),
      );
      for (const match of matches) {
        expect(match.players).toHaveLength(2);
        expect(match.status).toBe('ACTIVE');
      }
    },
  );
});
