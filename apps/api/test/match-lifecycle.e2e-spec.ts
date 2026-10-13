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
import { MatchTimeoutService } from '../src/matches/match-timeout.service.js';

/**
 * Phase 9 — resignation, draw offers, server-authoritative turn timers,
 * and the advisory-lock duplicate-match guard (see
 * docs/decisions/ADR-024-match-lifecycle-integrity.md). Mirrors the
 * exact harness conventions `matches.e2e-spec.ts`/`match-stakes.e2e-spec.ts`
 * already established (registerUser/makeAdmin/creditViaAdmin, direct
 * Prisma backdating instead of waiting real-time, calling
 * `MatchTimeoutService`'s sweeps synchronously rather than the real
 * interval).
 */
describe('Match lifecycle integrity (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let matchTimeoutService: MatchTimeoutService;
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
    matchTimeoutService = moduleFixture.get(MatchTimeoutService);
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

    const matchStakeIds = (
      await prisma.matchStake.findMany({
        where: { matchId: { in: matchIds } },
        select: { id: true },
      })
    ).map((s) => s.id);
    await prisma.settlement.deleteMany({
      where: { matchStakeId: { in: matchStakeIds } },
    });
    await prisma.matchStake.deleteMany({
      where: { id: { in: matchStakeIds } },
    });
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

  async function creditViaAdmin(
    adminToken: string,
    userId: string,
    amountMinor: string,
  ): Promise<void> {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/wallets/${userId}/adjustments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        direction: 'CREDIT',
        amountMinor,
        reason: 'Test fixture credit for e2e setup',
      })
      .expect(200);
  }

  async function availableBalance(userId: string): Promise<bigint> {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    return wallet.availableBalanceMinor;
  }

  function command(
    accessToken: string,
    matchId: string,
    body: { type?: string; payload?: Record<string, unknown> },
  ) {
    return request(app.getHttpServer())
      .post(`/api/v1/matches/${matchId}/commands`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        type: body.type,
        payload: body.payload ?? {},
      });
  }

  function move(accessToken: string, matchId: string, cell: number) {
    return command(accessToken, matchId, { payload: { cell } });
  }

  function getMatch(accessToken: string, matchId: string) {
    return request(app.getHttpServer())
      .get(`/api/v1/matches/${matchId}`)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  function financial(accessToken: string, matchId: string) {
    return request(app.getHttpServer())
      .get(`/api/v1/matches/${matchId}/financial`)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  function confirmStake(accessToken: string, matchId: string) {
    return request(app.getHttpServer())
      .post(`/api/v1/matches/${matchId}/stake/confirm`)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  /** A free-play ACTIVE match via challenge accept. */
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

  /** A WAITING, financially-backed match via a staked challenge. */
  async function createStakedMatch(
    labelPrefix: string,
    stakeAmountMinor: string,
  ): Promise<{
    matchId: string;
    x: { accessToken: string; userId: string };
    o: { accessToken: string; userId: string };
  }> {
    const x = await registerUser(`${labelPrefix}x`);
    const o = await registerUser(`${labelPrefix}o`);
    const admin = await registerUser(`${labelPrefix}a`);
    await makeAdmin(admin.userId);
    await creditViaAdmin(admin.accessToken, x.userId, '100000');
    await creditViaAdmin(admin.accessToken, o.userId, '100000');

    const challenge = await request(app.getHttpServer())
      .post('/api/v1/challenges')
      .set('Authorization', `Bearer ${x.accessToken}`)
      .send({
        gameId: 'tic_tac_toe',
        opponentUserId: o.userId,
        stake: { amountMinor: stakeAmountMinor, currency: 'SLE' },
      })
      .expect(201);

    const accepted = await request(app.getHttpServer())
      .post(`/api/v1/challenges/${challenge.body.id}/accept`)
      .set('Authorization', `Bearer ${o.accessToken}`)
      .expect(200);

    return { matchId: accepted.body.matchId as string, x, o };
  }

  async function confirmBothAndActivate(
    matchId: string,
    x: { accessToken: string },
    o: { accessToken: string },
  ): Promise<void> {
    await confirmStake(x.accessToken, matchId).expect(200);
    await confirmStake(o.accessToken, matchId).expect(200);
  }

  describe('resignation', () => {
    it('forfeits the match to the opponent and settles a staked game correctly', async () => {
      const { matchId, x, o } = await createStakedMatch('resign', '1000');
      const beforeX = await availableBalance(x.userId);
      const beforeO = await availableBalance(o.userId);
      await confirmBothAndActivate(matchId, x, o);

      const res = await command(x.accessToken, matchId, {
        type: 'RESIGN',
      }).expect(200);
      expect(res.body.resultStatus).toBe('ACCEPTED');

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('COMPLETED');
      expect(match.body.winnerUserId).toBe(o.userId);
      expect(match.body.resultIsDraw).toBe(false);
      expect(match.body.terminationReason).toBe('RESIGNATION');

      // Winner (o): stake back + net win. Loser (x, the resigner): held
      // released, nothing credited — same settlement math as any win.
      expect(await availableBalance(o.userId)).toBe(beforeO + 800n);
      expect(await availableBalance(x.userId)).toBe(beforeX - 1000n);

      const view = await financial(o.accessToken, matchId).expect(200);
      expect(view.body.settlement.outcome).toBe('WIN');
    });

    it('is idempotent — a repeated resignation (new commandId) is rejected, not reapplied', async () => {
      const { matchId, x, o } = await createActiveMatch('resignrepeat');
      await command(x.accessToken, matchId, { type: 'RESIGN' }).expect(200);

      const second = await command(x.accessToken, matchId, {
        type: 'RESIGN',
      }).expect(200);
      expect(second.body.resultStatus).toBe('REJECTED');
      expect(second.body.rejectionReason).toContain('already ended');

      const match = await getMatch(o.accessToken, matchId).expect(200);
      expect(match.body.winnerUserId).toBe(o.userId);
    });

    it('a late resignation after the match already ended by a move does not overwrite the real result', async () => {
      const { matchId, x, o } = await createActiveMatch('resignlate');
      // x wins outright via a real move.
      await move(x.accessToken, matchId, 0).expect(200);
      await move(o.accessToken, matchId, 3).expect(200);
      await move(x.accessToken, matchId, 1).expect(200);
      await move(o.accessToken, matchId, 4).expect(200);
      await move(x.accessToken, matchId, 2).expect(200);

      const afterWin = await getMatch(x.accessToken, matchId).expect(200);
      expect(afterWin.body.winnerUserId).toBe(x.userId);

      // o, about to lose, tries to resign — must not flip the result.
      const resignAttempt = await command(o.accessToken, matchId, {
        type: 'RESIGN',
      }).expect(200);
      expect(resignAttempt.body.resultStatus).toBe('REJECTED');

      const after = await getMatch(x.accessToken, matchId).expect(200);
      expect(after.body.winnerUserId).toBe(x.userId);
      expect(after.body.terminationReason).toBeNull();
    });

    it('a non-participant cannot resign a match they have no part in', async () => {
      const { matchId } = await createActiveMatch('resignoutsider');
      const outsider = await registerUser('resignoutsiderz');
      await command(outsider.accessToken, matchId, { type: 'RESIGN' }).expect(
        404,
      );
    });
  });

  describe('draw offers', () => {
    it('a full offer -> accept cycle completes the match as a draw and refunds a staked game', async () => {
      const { matchId, x, o } = await createStakedMatch('drawoffer', '500');
      const beforeX = await availableBalance(x.userId);
      const beforeO = await availableBalance(o.userId);
      await confirmBothAndActivate(matchId, x, o);

      const offer = await command(x.accessToken, matchId, {
        type: 'DRAW_OFFER',
      }).expect(200);
      expect(offer.body.resultStatus).toBe('ACCEPTED');

      // The offer alone does not complete the match.
      const midway = await getMatch(x.accessToken, matchId).expect(200);
      expect(midway.body.status).toBe('ACTIVE');
      expect(midway.body.pendingDrawOfferByUserId).toBe(x.userId);

      const accept = await command(o.accessToken, matchId, {
        type: 'DRAW_ACCEPT',
      }).expect(200);
      expect(accept.body.resultStatus).toBe('ACCEPTED');

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('COMPLETED');
      expect(match.body.resultIsDraw).toBe(true);
      expect(match.body.winnerUserId).toBeNull();
      expect(match.body.terminationReason).toBe('DRAW_AGREED');
      expect(match.body.pendingDrawOfferByUserId).toBeNull();

      // A draw refunds both stakes exactly, no fee — the existing DRAW
      // settlement path, unchanged.
      expect(await availableBalance(x.userId)).toBe(beforeX);
      expect(await availableBalance(o.userId)).toBe(beforeO);
      const view = await financial(x.accessToken, matchId).expect(200);
      expect(view.body.settlement.outcome).toBe('DRAW');
      expect(view.body.settlement.platformFeeAmountMinor).toBe('0');
    });

    it('rejects accepting your own draw offer', async () => {
      const { matchId, x } = await createActiveMatch('drawself');
      await command(x.accessToken, matchId, { type: 'DRAW_OFFER' }).expect(200);

      const selfAccept = await command(x.accessToken, matchId, {
        type: 'DRAW_ACCEPT',
      }).expect(200);
      expect(selfAccept.body.resultStatus).toBe('REJECTED');
      expect(selfAccept.body.rejectionReason).toContain('your own');

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('ACTIVE');
    });

    it('rejects accepting when there is no pending offer', async () => {
      const { matchId, o } = await createActiveMatch('drawnoneaccept');
      const res = await command(o.accessToken, matchId, {
        type: 'DRAW_ACCEPT',
      }).expect(200);
      expect(res.body.resultStatus).toBe('REJECTED');
      expect(res.body.rejectionReason).toBe('No pending draw offer');
    });

    it('rejects a second offer from the other side while one is already pending', async () => {
      const { matchId, x, o } = await createActiveMatch('drawduplicate');
      await command(x.accessToken, matchId, { type: 'DRAW_OFFER' }).expect(200);

      const crossOffer = await command(o.accessToken, matchId, {
        type: 'DRAW_OFFER',
      }).expect(200);
      expect(crossOffer.body.resultStatus).toBe('REJECTED');
      expect(crossOffer.body.rejectionReason).toContain('already pending');

      // The original offer is untouched.
      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.pendingDrawOfferByUserId).toBe(x.userId);
    });

    it('a repeated offer from the same side refreshes rather than rejects', async () => {
      const { matchId, x } = await createActiveMatch('drawrefresh');
      await command(x.accessToken, matchId, { type: 'DRAW_OFFER' }).expect(200);
      const second = await command(x.accessToken, matchId, {
        type: 'DRAW_OFFER',
      }).expect(200);
      expect(second.body.resultStatus).toBe('ACCEPTED');
    });

    it('DRAW_REJECT clears a pending offer and is usable by either side', async () => {
      const { matchId, x, o } = await createActiveMatch('drawreject');
      await command(x.accessToken, matchId, { type: 'DRAW_OFFER' }).expect(200);

      const reject = await command(o.accessToken, matchId, {
        type: 'DRAW_REJECT',
      }).expect(200);
      expect(reject.body.resultStatus).toBe('ACCEPTED');

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.pendingDrawOfferByUserId).toBeNull();
      expect(match.body.status).toBe('ACTIVE');

      // Now that it's clear, accepting is correctly rejected (nothing pending).
      const accept = await command(o.accessToken, matchId, {
        type: 'DRAW_ACCEPT',
      }).expect(200);
      expect(accept.body.resultStatus).toBe('REJECTED');
    });

    it('a real move implicitly withdraws a pending offer from its submitter', async () => {
      const { matchId, x, o } = await createActiveMatch('drawwithdraw');
      await command(x.accessToken, matchId, { type: 'DRAW_OFFER' }).expect(200);

      await move(x.accessToken, matchId, 0).expect(200);

      const match = await getMatch(o.accessToken, matchId).expect(200);
      expect(match.body.pendingDrawOfferByUserId).toBeNull();
    });

    it('an expired offer cannot be accepted', async () => {
      const { matchId, x, o } = await createActiveMatch('drawexpired');
      await command(x.accessToken, matchId, { type: 'DRAW_OFFER' }).expect(200);

      await prisma.match.update({
        where: { id: matchId },
        data: { pendingDrawOfferExpiresAt: new Date(Date.now() - 1000) },
      });

      const accept = await command(o.accessToken, matchId, {
        type: 'DRAW_ACCEPT',
      }).expect(200);
      expect(accept.body.resultStatus).toBe('REJECTED');

      // The periodic sweep also clears it for display hygiene.
      await matchTimeoutService.sweep();
      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.pendingDrawOfferByUserId).toBeNull();
    });
  });

  describe('server-authoritative turn timers', () => {
    it('forfeits the match to the opponent once the turn deadline elapses, and settles a staked game', async () => {
      const { matchId, x, o } = await createStakedMatch('turntimeout', '400');
      const beforeO = await availableBalance(o.userId);
      await confirmBothAndActivate(matchId, x, o);
      // x moves first (seat 0) — o now holds the turn.
      await move(x.accessToken, matchId, 0).expect(200);

      await prisma.match.update({
        where: { id: matchId },
        data: { turnDeadlineAt: new Date(Date.now() - 1000) },
      });
      await matchTimeoutService.processTurnTimeout(matchId);

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('COMPLETED');
      expect(match.body.winnerUserId).toBe(x.userId);
      expect(match.body.terminationReason).toBe('TURN_TIMEOUT');

      expect(await availableBalance(o.userId)).toBe(beforeO - 400n);
      const view = await financial(x.accessToken, matchId).expect(200);
      expect(view.body.settlement.outcome).toBe('WIN');
    });

    it('does not fire while the turn-holder is still within their deadline', async () => {
      const { matchId, x } = await createActiveMatch('turnnotyet');
      // A fresh match's deadline is in the future — processing is a no-op.
      await matchTimeoutService.processTurnTimeout(matchId);
      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('ACTIVE');
      expect(match.body.turnDeadlineAt).not.toBeNull();
    });

    it('a move racing an expired deadline wins — the sweep safely no-ops afterwards', async () => {
      const { matchId, x, o } = await createActiveMatch('turnrace');
      await prisma.match.update({
        where: { id: matchId },
        data: { turnDeadlineAt: new Date(Date.now() - 1000) },
      });

      // The real move commits first...
      await move(x.accessToken, matchId, 0).expect(200);
      // ...so the sweep, run immediately after, must not overwrite it.
      await matchTimeoutService.processTurnTimeout(matchId);

      const match = await getMatch(o.accessToken, matchId).expect(200);
      expect(match.body.status).toBe('ACTIVE');
      expect(match.body.winnerUserId).toBeNull();
    });

    it('processing the same timeout twice is idempotent — exactly one settlement', async () => {
      const { matchId, x, o } = await createStakedMatch('turndup', '300');
      await confirmBothAndActivate(matchId, x, o);
      await move(x.accessToken, matchId, 0).expect(200);

      await prisma.match.update({
        where: { id: matchId },
        data: { turnDeadlineAt: new Date(Date.now() - 1000) },
      });

      await Promise.all([
        matchTimeoutService.processTurnTimeout(matchId),
        matchTimeoutService.processTurnTimeout(matchId),
      ]);

      const match = await getMatch(x.accessToken, matchId).expect(200);
      expect(match.body.winnerUserId).toBe(x.userId);

      const financialView = await financial(x.accessToken, matchId).expect(200);
      expect(financialView.body.stake.status).toBe('SETTLED');

      const settlementCount = await prisma.settlement.count({
        where: { matchStakeId: financialView.body.stake.id },
      });
      expect(settlementCount).toBe(1);
    });

    it('refreshes the deadline on every accepted move', async () => {
      const { matchId, x } = await createActiveMatch('turnrefresh');
      const before = await getMatch(x.accessToken, matchId).expect(200);
      const beforeDeadline = new Date(before.body.turnDeadlineAt).getTime();

      await move(x.accessToken, matchId, 0).expect(200);

      const after = await getMatch(x.accessToken, matchId).expect(200);
      const afterDeadline = new Date(after.body.turnDeadlineAt).getTime();
      expect(afterDeadline).toBeGreaterThan(beforeDeadline);
    });

    it('a staked match only starts its turn clock once the match becomes ACTIVE, not at WAITING creation', async () => {
      const { matchId, x, o } = await createStakedMatch('turnwaiting', '100');
      const waiting = await getMatch(x.accessToken, matchId).expect(200);
      expect(waiting.body.status).toBe('WAITING');
      expect(waiting.body.turnDeadlineAt).toBeNull();

      await confirmBothAndActivate(matchId, x, o);
      const active = await getMatch(x.accessToken, matchId).expect(200);
      expect(active.body.status).toBe('ACTIVE');
      expect(active.body.turnDeadlineAt).not.toBeNull();
    });
  });

  describe('duplicate-match prevention (advisory lock)', () => {
    it('two challenges accepted concurrently by the same user form exactly one match; the loser stays PENDING', async () => {
      const shared = await registerUser('dupshared');
      const challengerA = await registerUser('dupa');
      const challengerB = await registerUser('dupb');

      const challengeA = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${challengerA.accessToken}`)
        .send({ gameId: 'tic_tac_toe', opponentUserId: shared.userId })
        .expect(201);
      const challengeB = await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${challengerB.accessToken}`)
        .send({ gameId: 'tic_tac_toe', opponentUserId: shared.userId })
        .expect(201);

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/challenges/${challengeA.body.id}/accept`)
          .set('Authorization', `Bearer ${shared.accessToken}`),
        request(app.getHttpServer())
          .post(`/api/v1/challenges/${challengeB.body.id}/accept`)
          .set('Authorization', `Bearer ${shared.accessToken}`),
      ]);

      const outcomes = [resA, resB].map((r) => r.status);
      expect(outcomes.sort()).toEqual([200, 409]);

      const winner = resA.status === 200 ? resA : resB;
      const loser = resA.status === 200 ? challengeB : challengeA;

      // Exactly one real match exists for `shared`.
      const matches = await prisma.matchPlayer.count({
        where: {
          userId: shared.userId,
          match: { status: { in: ['WAITING', 'READY', 'ACTIVE'] } },
        },
      });
      expect(matches).toBe(1);

      // The losing accept's challenge rolled back to PENDING, not left
      // half-resolved — it can still be declined/cancelled/retried later.
      const loserChallenge = await prisma.challenge.findUniqueOrThrow({
        where: { id: loser.body.id },
      });
      expect(loserChallenge.status).toBe('PENDING');
      void winner;
    });

    it("matchmaking's join rejects a user already in a WAITING staked match (not just ACTIVE)", async () => {
      const { x } = await createStakedMatch('waitingblind', '100');

      const res = await request(app.getHttpServer())
        .post('/api/v1/matchmaking/join')
        .set('Authorization', `Bearer ${x.accessToken}`)
        .send({ gameId: 'tic_tac_toe' });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain(
        'already in an active or pending match',
      );
    });
  });
});
