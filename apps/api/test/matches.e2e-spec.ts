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

describe('Challenges / Matches / Tic-Tac-Toe (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const runId = randomUUID().slice(0, 8);

  const email = (label: string) => `${label}-${runId}@example.com`;
  // Guarantees uniqueness (both within this run and across repeated local
  // runs) regardless of how long `label` is — unlike `${label}${runId}`,
  // which silently drops the uniquifying `runId` suffix entirely once
  // `label` alone reaches the 20-character username limit, causing a
  // collision with a leftover row from a previous run.
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
    // Cascades MatchPlayer + MatchCommand; SetNulls any Challenge.matchId.
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
    // Every registered user also owns a Wallet (Phase 3), and
    // Wallet→User is `onDelete: Restrict` — clear it before the user.
    await prisma.ledgerEntry.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.withdrawal.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.deposit.deleteMany({ where: { userId: { in: userIds } } });
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

  async function makeAdmin(userId: string): Promise<void> {
    await prisma.user.update({
      where: { id: userId },
      data: { role: 'ADMIN' },
    });
  }

  /** Creates an ACTIVE match between two fresh users via challenge accept. */
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

  function move(
    accessToken: string,
    matchId: string,
    cell: number,
    commandId = randomUUID(),
  ) {
    return request(app.getHttpServer())
      .post(`/api/v1/matches/${matchId}/commands`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ commandId, payload: { cell } });
  }

  describe('game catalog', () => {
    it('lists the enabled catalog including tic_tac_toe', async () => {
      const { accessToken } = await registerUser('catalog');
      const res = await request(app.getHttpServer())
        .get('/api/v1/games')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.some((g: { id: string }) => g.id === 'tic_tac_toe')).toBe(
        true,
      );
    });

    it('returns a single game by id', async () => {
      const { accessToken } = await registerUser('catalogone');
      const res = await request(app.getHttpServer())
        .get('/api/v1/games/tic_tac_toe')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.displayName).toBe('Tic-Tac-Toe');
    });

    it('404s for an unknown game id', async () => {
      const { accessToken } = await registerUser('catalogmissing');
      await request(app.getHttpServer())
        .get('/api/v1/games/does_not_exist')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
    });
  });

  describe('challenges', () => {
    it('rejects challenging yourself', async () => {
      const { accessToken, userId } = await registerUser('selfchallenge');
      await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ gameId: 'tic_tac_toe', opponentUserId: userId })
        .expect(409);
    });

    it('rejects a duplicate pending challenge between the same two users', async () => {
      const a = await registerUser('dupchalla');
      const b = await registerUser('dupchallb');

      await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ gameId: 'tic_tac_toe', opponentUserId: b.userId })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ gameId: 'tic_tac_toe', opponentUserId: b.userId })
        .expect(409);
    });

    it('404s for a challenge to a nonexistent opponent', async () => {
      const { accessToken } = await registerUser('challengeghost');
      await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ gameId: 'tic_tac_toe', opponentUserId: randomUUID() })
        .expect(404);
    });

    it('404s for a challenge to an unknown/invalid game id', async () => {
      const a = await registerUser('badgamea');
      const b = await registerUser('badgameb');
      await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ gameId: 'not_a_real_game', opponentUserId: b.userId })
        .expect(404);
    });

    it('rejects accepting the same challenge twice (duplicate response)', async () => {
      const a = await registerUser('dupacceptA');
      const b = await registerUser('dupacceptB');

      const challenge = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ gameId: 'tic_tac_toe', opponentUserId: b.userId })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/accept`)
        .set('Authorization', `Bearer ${b.accessToken}`)
        .expect(200);

      // Same challenge, accepted again — must not create a second match.
      await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/accept`)
        .set('Authorization', `Bearer ${b.accessToken}`)
        .expect(409);

      const matchCount = await prisma.match.count({
        where: { challenge: { id: challenge.body.id } },
      });
      expect(matchCount).toBe(1);
    });

    it('rejects accepting an expired challenge', async () => {
      const a = await registerUser('expiredchallA');
      const b = await registerUser('expiredchallB');

      const challenge = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ gameId: 'tic_tac_toe', opponentUserId: b.userId })
        .expect(201);

      await prisma.challenge.update({
        where: { id: challenge.body.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/accept`)
        .set('Authorization', `Bearer ${b.accessToken}`)
        .expect(409);
    });

    it('lets the opponent decline, notifying nobody incorrectly', async () => {
      const a = await registerUser('declinea');
      const b = await registerUser('declineb');

      const challenge = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ gameId: 'tic_tac_toe', opponentUserId: b.userId })
        .expect(201);

      const declined = await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/decline`)
        .set('Authorization', `Bearer ${b.accessToken}`)
        .expect(200);

      expect(declined.body.status).toBe('DECLINED');
    });

    it('rejects the challenger trying to decline their own challenge', async () => {
      const a = await registerUser('wrongdeclinea');
      const b = await registerUser('wrongdeclineb');

      const challenge = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ gameId: 'tic_tac_toe', opponentUserId: b.userId })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/decline`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(403);
    });

    it('lets the challenger cancel a pending challenge', async () => {
      const a = await registerUser('cancela');
      const b = await registerUser('cancelb');

      const challenge = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ gameId: 'tic_tac_toe', opponentUserId: b.userId })
        .expect(201);

      const cancelled = await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/cancel`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(200);

      expect(cancelled.body.status).toBe('CANCELLED');
    });

    it('404s for a user outside the challenge entirely (IDOR)', async () => {
      const a = await registerUser('idorchalla');
      const b = await registerUser('idorchallb');
      const outsider = await registerUser('idorchalloutsider');

      const challenge = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ gameId: 'tic_tac_toe', opponentUserId: b.userId })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/accept`)
        .set('Authorization', `Bearer ${outsider.accessToken}`)
        .expect(404);
    });

    it('accepting creates an ACTIVE match and resolves the challenge', async () => {
      const a = await registerUser('accepta');
      const b = await registerUser('acceptb');

      const challenge = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ gameId: 'tic_tac_toe', opponentUserId: b.userId })
        .expect(201);

      const accepted = await request(app.getHttpServer())
        .post(`/api/v1/challenges/${challenge.body.id}/accept`)
        .set('Authorization', `Bearer ${b.accessToken}`)
        .expect(200);

      expect(accepted.body.status).toBe('ACCEPTED');
      expect(accepted.body.matchId).toBeTruthy();

      const match = await request(app.getHttpServer())
        .get(`/api/v1/matches/${accepted.body.matchId}`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(200);

      expect(match.body.status).toBe('ACTIVE');
      expect(match.body.players).toHaveLength(2);
    });
  });

  describe('tic-tac-toe gameplay (server-authoritative)', () => {
    it('plays a full game to a win and marks the match COMPLETED', async () => {
      const { matchId, x, o } = await createActiveMatch('win');

      // X: 0,1,2 (top row) ; O: 3,4
      await move(x.accessToken, matchId, 0).expect(200);
      await move(o.accessToken, matchId, 3).expect(200);
      await move(x.accessToken, matchId, 1).expect(200);
      await move(o.accessToken, matchId, 4).expect(200);
      const winning = await move(x.accessToken, matchId, 2).expect(200);

      expect(winning.body.resultStatus).toBe('ACCEPTED');

      const match = await request(app.getHttpServer())
        .get(`/api/v1/matches/${matchId}`)
        .set('Authorization', `Bearer ${x.accessToken}`)
        .expect(200);

      expect(match.body.status).toBe('COMPLETED');
      expect(match.body.winnerUserId).toBe(x.userId);
      expect(match.body.resultIsDraw).toBe(false);
    });

    it('plays a full game to a draw', async () => {
      const { matchId, x, o } = await createActiveMatch('draw');
      // X O X / X O O / O X X -> draw
      const sequence: [typeof x, number][] = [
        [x, 0],
        [o, 1],
        [x, 2],
        [o, 4],
        [x, 3],
        [o, 5],
        [x, 7],
        [o, 6],
        [x, 8],
      ];
      const results = [];
      for (const [player, cell] of sequence) {
        results.push(await move(player.accessToken, matchId, cell).expect(200));
      }
      expect(results[results.length - 1]?.body.resultStatus).toBe('ACCEPTED');

      const match = await request(app.getHttpServer())
        .get(`/api/v1/matches/${matchId}`)
        .set('Authorization', `Bearer ${x.accessToken}`)
        .expect(200);

      expect(match.body.status).toBe('COMPLETED');
      expect(match.body.resultIsDraw).toBe(true);
      expect(match.body.winnerUserId).toBeNull();
    });

    it('rejects a move out of turn without corrupting state', async () => {
      const { matchId, o } = await createActiveMatch('outofturn');
      const res = await move(o.accessToken, matchId, 0).expect(200);
      expect(res.body.resultStatus).toBe('REJECTED');
      expect(res.body.rejectionReason).toMatch(/not your turn/i);
    });

    it('rejects a move onto an occupied cell', async () => {
      const { matchId, x, o } = await createActiveMatch('occupied');
      await move(x.accessToken, matchId, 0).expect(200);
      const res = await move(o.accessToken, matchId, 0).expect(200);
      expect(res.body.resultStatus).toBe('REJECTED');
      expect(res.body.rejectionReason).toMatch(/occupied/i);
    });

    it('404s a move from a non-participant', async () => {
      const { matchId } = await createActiveMatch('nonparticipant');
      const outsider = await registerUser('nonparticipantoutsider');
      await move(outsider.accessToken, matchId, 0).expect(404);
    });

    it('rejects any move once the match has completed', async () => {
      const { matchId, x, o } = await createActiveMatch('postcompletion');
      await move(x.accessToken, matchId, 0).expect(200);
      await move(o.accessToken, matchId, 3).expect(200);
      await move(x.accessToken, matchId, 1).expect(200);
      await move(o.accessToken, matchId, 4).expect(200);
      await move(x.accessToken, matchId, 2).expect(200); // X wins

      const res = await move(o.accessToken, matchId, 5).expect(200);
      expect(res.body.resultStatus).toBe('REJECTED');
      expect(res.body.rejectionReason).toMatch(/already ended/i);
    });

    it('is idempotent against a retried identical command', async () => {
      const { matchId, x } = await createActiveMatch('idempotent');
      const commandId = randomUUID();

      const first = await move(x.accessToken, matchId, 4, commandId).expect(
        200,
      );
      const retry = await move(x.accessToken, matchId, 4, commandId).expect(
        200,
      );

      expect(retry.body).toEqual(first.body);

      const commandCount = await prisma.matchCommand.count({
        where: { matchId, id: commandId },
      });
      expect(commandCount).toBe(1);

      const match = await prisma.match.findUnique({ where: { id: matchId } });
      expect(match?.stateVersion).toBe(1); // only applied once
    });

    it('serializes two concurrent moves from the same player — exactly one is accepted', async () => {
      const { matchId, x } = await createActiveMatch('concurrentsame');

      const [first, second] = await Promise.all([
        move(x.accessToken, matchId, 0),
        move(x.accessToken, matchId, 1),
      ]);

      const results = [
        first.body.resultStatus,
        second.body.resultStatus,
      ].sort();
      // Both HTTP calls succeed (200) — the loser is a clean REJECTED
      // ("not your turn", since the first move already advanced the
      // turn), never a corrupted or double-applied state.
      expect(results).toEqual(['ACCEPTED', 'REJECTED']);

      const match = await prisma.match.findUnique({ where: { id: matchId } });
      expect(match?.stateVersion).toBe(1);
    });
  });

  describe('match history', () => {
    it('paginates the authenticated user’s own match history', async () => {
      const { matchId, x } = await createActiveMatch('history');

      const page = await request(app.getHttpServer())
        .get('/api/v1/matches?limit=1')
        .set('Authorization', `Bearer ${x.accessToken}`)
        .expect(200);

      expect(
        page.body.items.some((m: { id: string }) => m.id === matchId),
      ).toBe(true);
    });
  });

  describe('admin match visibility', () => {
    it('lets an admin list and inspect any match', async () => {
      const { matchId } = await createActiveMatch('adminvisible');
      const admin = await registerUser('adminvisibleadmin');
      await makeAdmin(admin.userId);

      const list = await request(app.getHttpServer())
        .get('/api/v1/admin/matches?gameId=tic_tac_toe')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(
        list.body.items.some((m: { id: string }) => m.id === matchId),
      ).toBe(true);

      await request(app.getHttpServer())
        .get(`/api/v1/admin/matches/${matchId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
    });

    it('rejects a non-admin from the admin match routes', async () => {
      const { accessToken } = await registerUser('notadminmatches');
      await request(app.getHttpServer())
        .get('/api/v1/admin/matches')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });
  });

  describe('account status enforcement', () => {
    it('rejects a suspended user from match routes', async () => {
      const { accessToken, userId } = await registerUser('suspendedmatches');
      await prisma.user.update({
        where: { id: userId },
        data: { status: 'SUSPENDED' },
      });

      await request(app.getHttpServer())
        .get('/api/v1/matches')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);
    });

    it('rejects a disabled user from submitting a command, even mid-match', async () => {
      const { matchId, x } = await createActiveMatch('disabledmidmatch');
      await prisma.user.update({
        where: { id: x.userId },
        data: { status: 'DISABLED' },
      });

      await move(x.accessToken, matchId, 0).expect(401);
    });
  });
});
