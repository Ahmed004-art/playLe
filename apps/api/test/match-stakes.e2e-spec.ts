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
import { SettlementService } from '../src/settlement/settlement.service.js';
import { SYSTEM_ACCOUNT_USER_ID } from '../src/system-account/system-account.constants.js';

describe('Match Stakes / Settlement / Disputes / Reconciliation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let matchTimeoutService: MatchTimeoutService;
  let settlementService: SettlementService;
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
    settlementService = moduleFixture.get(SettlementService);
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

    // Settlement/MatchStake/Dispute are all `onDelete: Restrict` toward
    // Match — must be removed before Match itself (SettlementEntry/
    // MatchStakePlayer cascade from their own parents automatically).
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
    await prisma.dispute.deleteMany({
      where: { raisedByUserId: { in: userIds } },
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
    dateOfBirth = '2000-01-01',
  ): Promise<{ accessToken: string; userId: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: email(label),
        username: username(label),
        password: 'Passw0rd1',
        dateOfBirth,
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
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId },
    });
    return wallet.availableBalanceMinor;
  }

  async function heldBalance(userId: string): Promise<bigint> {
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId },
    });
    return wallet.heldBalanceMinor;
  }

  function move(accessToken: string, matchId: string, cell: number) {
    return request(app.getHttpServer())
      .post(`/api/v1/matches/${matchId}/commands`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ commandId: randomUUID(), payload: { cell } });
  }

  function confirmStake(accessToken: string, matchId: string) {
    return request(app.getHttpServer())
      .post(`/api/v1/matches/${matchId}/stake/confirm`)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  function financial(accessToken: string, matchId: string) {
    return request(app.getHttpServer())
      .get(`/api/v1/matches/${matchId}/financial`)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  /** Creates a WAITING, financially-backed match via a staked challenge. */
  async function createStakedMatch(
    labelPrefix: string,
    stakeAmountMinor: string,
    fundingAmountMinor = '100000',
  ): Promise<{
    matchId: string;
    x: { accessToken: string; userId: string };
    o: { accessToken: string; userId: string };
    admin: { accessToken: string; userId: string };
  }> {
    const x = await registerUser(`${labelPrefix}x`);
    const o = await registerUser(`${labelPrefix}o`);
    const admin = await registerUser(`${labelPrefix}a`);
    await makeAdmin(admin.userId);
    await creditViaAdmin(admin.accessToken, x.userId, fundingAmountMinor);
    await creditViaAdmin(admin.accessToken, o.userId, fundingAmountMinor);

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

    return { matchId: accepted.body.matchId as string, x, o, admin };
  }

  /** Confirms both players' stakes and asserts the match is now ACTIVE. */
  async function confirmBothAndActivate(
    matchId: string,
    x: { accessToken: string },
    o: { accessToken: string },
  ): Promise<void> {
    await confirmStake(x.accessToken, matchId).expect(200);
    const afterSecond = await confirmStake(o.accessToken, matchId).expect(200);
    expect(afterSecond.body.stake.status).toBe('ACTIVE');

    const match = await request(app.getHttpServer())
      .get(`/api/v1/matches/${matchId}`)
      .set('Authorization', `Bearer ${x.accessToken}`)
      .expect(200);
    expect(match.body.status).toBe('ACTIVE');
  }

  async function playToWin(
    matchId: string,
    x: { accessToken: string },
    o: { accessToken: string },
  ): Promise<void> {
    await move(x.accessToken, matchId, 0).expect(200);
    await move(o.accessToken, matchId, 3).expect(200);
    await move(x.accessToken, matchId, 1).expect(200);
    await move(o.accessToken, matchId, 4).expect(200);
    await move(x.accessToken, matchId, 2).expect(200);
  }

  async function playToDraw(
    matchId: string,
    x: { accessToken: string },
    o: { accessToken: string },
  ): Promise<void> {
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
    for (const [player, cell] of sequence) {
      await move(player.accessToken, matchId, cell).expect(200);
    }
  }

  describe('full lifecycle — win', () => {
    it('matches the documented example exactly, settles once, and leaves no anomaly', async () => {
      const { matchId, x, o } = await createStakedMatch('win', '1000');

      const beforeX = await availableBalance(x.userId);
      const beforeO = await availableBalance(o.userId);

      await confirmBothAndActivate(matchId, x, o);
      expect(await availableBalance(x.userId)).toBe(beforeX - 1000n);
      expect(await heldBalance(x.userId)).toBe(1000n);
      expect(await availableBalance(o.userId)).toBe(beforeO - 1000n);
      expect(await heldBalance(o.userId)).toBe(1000n);

      await playToWin(matchId, x, o);

      // Winner (x): own Le10 stake back + Le8 net win = Le18 credited,
      // held released. Loser (o): held released, nothing credited.
      expect(await availableBalance(x.userId)).toBe(beforeX + 800n);
      expect(await heldBalance(x.userId)).toBe(0n);
      expect(await availableBalance(o.userId)).toBe(beforeO - 1000n);
      expect(await heldBalance(o.userId)).toBe(0n);

      const view = await financial(x.accessToken, matchId).expect(200);
      expect(view.body.stake.status).toBe('SETTLED');
      expect(view.body.settlement.outcome).toBe('WIN');
      expect(view.body.settlement.poolAmountMinor).toBe('2000');
      expect(view.body.settlement.platformFeeAmountMinor).toBe('200');

      // Idempotent retry: calling settle() again must not pay twice.
      await settlementService.settle(matchId);
      expect(await availableBalance(x.userId)).toBe(beforeX + 800n);
      expect(await heldBalance(o.userId)).toBe(0n);

      const platformWallet = await prisma.wallet.findUniqueOrThrow({
        where: { userId: SYSTEM_ACCOUNT_USER_ID },
      });
      const platformEntries = await prisma.ledgerEntry.count({
        where: {
          walletId: platformWallet.id,
          relatedMatchStakeId: view.body.stake.id,
        },
      });
      expect(platformEntries).toBe(1);
    });
  });

  describe('full lifecycle — draw', () => {
    it('refunds both players exactly their stake, with no fee', async () => {
      const { matchId, x, o } = await createStakedMatch('draw', '500');
      const beforeX = await availableBalance(x.userId);
      const beforeO = await availableBalance(o.userId);

      await confirmBothAndActivate(matchId, x, o);
      await playToDraw(matchId, x, o);

      expect(await availableBalance(x.userId)).toBe(beforeX);
      expect(await heldBalance(x.userId)).toBe(0n);
      expect(await availableBalance(o.userId)).toBe(beforeO);
      expect(await heldBalance(o.userId)).toBe(0n);

      const view = await financial(x.accessToken, matchId).expect(200);
      expect(view.body.settlement.outcome).toBe('DRAW');
      expect(view.body.settlement.platformFeeAmountMinor).toBe('0');
    });
  });

  describe('stake-commit timeout', () => {
    it('cancels the match and refunds whichever player already held', async () => {
      const { matchId, x, o } = await createStakedMatch('timeout', '750');
      const beforeX = await availableBalance(x.userId);

      await confirmStake(x.accessToken, matchId).expect(200);
      expect(await heldBalance(x.userId)).toBe(750n);

      await prisma.match.update({
        where: { id: matchId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await matchTimeoutService.sweep();

      const match = await request(app.getHttpServer())
        .get(`/api/v1/matches/${matchId}`)
        .set('Authorization', `Bearer ${x.accessToken}`)
        .expect(200);
      expect(match.body.status).toBe('CANCELLED');

      expect(await availableBalance(x.userId)).toBe(beforeX);
      expect(await heldBalance(x.userId)).toBe(0n);
      // o never confirmed — never held anything to refund.
      expect(await heldBalance(o.userId)).toBe(0n);

      const view = await financial(x.accessToken, matchId).expect(200);
      expect(view.body.stake.status).toBe('REFUNDED');
      expect(view.body.settlement.outcome).toBe('CANCELLED');
    });
  });

  describe('disconnect forfeit settles like a win', () => {
    it('awards the connected player a forfeit win and settles it', async () => {
      const { matchId, x, o } = await createStakedMatch('forfeit', '600');
      await confirmBothAndActivate(matchId, x, o);

      await prisma.matchPlayer.updateMany({
        where: { matchId, userId: o.userId },
        data: { disconnectedAt: new Date(Date.now() - 60_000) },
      });
      await matchTimeoutService.sweep();

      const match = await request(app.getHttpServer())
        .get(`/api/v1/matches/${matchId}`)
        .set('Authorization', `Bearer ${x.accessToken}`)
        .expect(200);
      expect(match.body.status).toBe('ABANDONED');
      expect(match.body.winnerUserId).toBe(x.userId);

      const view = await financial(x.accessToken, matchId).expect(200);
      expect(view.body.settlement.outcome).toBe('WIN');
      expect(await heldBalance(x.userId)).toBe(0n);
      expect(await heldBalance(o.userId)).toBe(0n);
    });
  });

  describe('eligibility and validation (via a staked challenge — no Redis needed)', () => {
    it('rejects a stake below the configured minimum', async () => {
      const a = await registerUser('stakemin');
      const b = await registerUser('stakeminopp');
      await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: b.userId,
          stake: { amountMinor: '1', currency: 'SLE' },
        })
        .expect(422);
    });

    it('rejects a user under the real-money minimum age', async () => {
      const tooYoung = new Date();
      tooYoung.setFullYear(tooYoung.getFullYear() - 17);
      const a = await registerUser(
        'stakeyoung',
        tooYoung.toISOString().slice(0, 10),
      );
      const b = await registerUser('stakeyoungopp');
      await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: b.userId,
          stake: { amountMinor: '1000', currency: 'SLE' },
        })
        .expect(403);
    });

    it('rejects staking more than the available balance', async () => {
      const a = await registerUser('stakepoor');
      const b = await registerUser('stakepooropp');
      await request(app.getHttpServer())
        .post('/api/v1/challenges')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({
          gameId: 'tic_tac_toe',
          opponentUserId: b.userId,
          stake: { amountMinor: '1000', currency: 'SLE' },
        })
        .expect(422);
    });
  });

  describe('security', () => {
    it('404s a non-participant reading the financial view (IDOR)', async () => {
      const { matchId } = await createStakedMatch('idorfin', '1000');
      const outsider = await registerUser('idorfinoutsider');

      await financial(outsider.accessToken, matchId).expect(404);
    });

    it('404s a non-participant trying to confirm a stake they have no part in', async () => {
      const { matchId } = await createStakedMatch('idorconfirm', '1000');
      const outsider = await registerUser('idorconfirmoutsider');

      await confirmStake(outsider.accessToken, matchId).expect(404);
    });

    it('is idempotent and concurrency-safe against a double confirm by the same player', async () => {
      const { matchId, x, o } = await createStakedMatch(
        'doubleconfirm',
        '1000',
      );
      const before = await availableBalance(x.userId);

      const [first, second] = await Promise.all([
        confirmStake(x.accessToken, matchId),
        confirmStake(x.accessToken, matchId),
      ]);
      expect([first.status, second.status]).toEqual([200, 200]);

      // Exactly one hold — not two.
      expect(await availableBalance(x.userId)).toBe(before - 1000n);
      expect(await heldBalance(x.userId)).toBe(1000n);

      await confirmStake(o.accessToken, matchId).expect(200);
    });
  });

  describe('disputes', () => {
    it('lets a participant open a dispute on a completed match, visible to admin, resolvable without moving money', async () => {
      const { matchId, x, o, admin } = await createStakedMatch(
        'dispute',
        '400',
      );
      await confirmBothAndActivate(matchId, x, o);
      await playToWin(matchId, x, o);

      const loserBalance = await availableBalance(o.userId);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/matches/${matchId}/dispute`)
        .set('Authorization', `Bearer ${o.accessToken}`)
        .send({ reason: 'I think there was a client-side rendering glitch' })
        .expect(201);
      expect(created.body.status).toBe('OPEN');

      // Duplicate open dispute by the same user is rejected.
      await request(app.getHttpServer())
        .post(`/api/v1/matches/${matchId}/dispute`)
        .set('Authorization', `Bearer ${o.accessToken}`)
        .send({ reason: 'Filing again just in case' })
        .expect(409);

      // An outsider cannot dispute a match they weren't in (IDOR).
      const outsider = await registerUser('disputeoutsider');
      await request(app.getHttpServer())
        .post(`/api/v1/matches/${matchId}/dispute`)
        .set('Authorization', `Bearer ${outsider.accessToken}`)
        .send({ reason: 'Not my match but trying anyway' })
        .expect(404);

      const resolved = await request(app.getHttpServer())
        .post(`/api/v1/admin/disputes/${created.body.id}/resolve`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          status: 'RESOLVED',
          resolution: 'Reviewed the match log — result stands as played',
        })
        .expect(200);
      expect(resolved.body.status).toBe('RESOLVED');

      // Resolving a dispute never itself moves money.
      expect(await availableBalance(o.userId)).toBe(loserBalance);

      // Resolving again is rejected — already final.
      await request(app.getHttpServer())
        .post(`/api/v1/admin/disputes/${created.body.id}/resolve`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ status: 'RESOLVED', resolution: 'Trying to resolve twice' })
        .expect(403);
    });
  });

  describe('admin visibility', () => {
    it("lets an admin inspect any match's full financial detail, no participant restriction", async () => {
      const { matchId, x, o, admin } = await createStakedMatch(
        'adminfin',
        '900',
      );
      await confirmBothAndActivate(matchId, x, o);
      await playToWin(matchId, x, o);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/admin/matches/${matchId}/financial`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      expect(res.body.stake.status).toBe('SETTLED');
      expect(res.body.settlement.outcome).toBe('WIN');
      expect(res.body.settlement.poolAmountMinor).toBe('1800');
    });

    it('rejects a non-admin from the financial admin routes', async () => {
      const { matchId } = await createStakedMatch('adminfinauth', '100');
      const notAdmin = await registerUser('notadmin');

      await request(app.getHttpServer())
        .get(`/api/v1/admin/matches/${matchId}/financial`)
        .set('Authorization', `Bearer ${notAdmin.accessToken}`)
        .expect(403);
    });
  });

  describe('reconciliation', () => {
    it('reports no anomaly after a normal settled lifecycle', async () => {
      const { matchId, x, o, admin } = await createStakedMatch('recon', '300');
      await confirmBothAndActivate(matchId, x, o);
      await playToWin(matchId, x, o);

      const report = await request(app.getHttpServer())
        .get('/api/v1/admin/reconciliation/run')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      const relevant = report.body.anomalies.filter(
        (a: { matchId?: string }) => a.matchId === matchId,
      );
      expect(relevant).toHaveLength(0);
    });
  });
});
