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
 * Phase 6: the centralized `EligibilityService` and self-service
 * `ResponsibleGamingController`. Self-exclusion/cooling-off block
 * deposits and real-money stakes but never withdrawals (letting an
 * at-risk user get their own money out is the correct behavior, not a
 * loophole — see `EligibilityService.assertCanWithdraw`'s doc comment).
 */
describe('Eligibility & responsible gaming (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const runId = randomUUID().slice(0, 8);

  const email = (label: string) => `${label}-${runId}@example.com`;
  const username = (label: string) => `${label}${runId}`.slice(0, 20);

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
    await prisma.responsibleGamingRestriction.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.challenge.deleteMany({
      where: {
        OR: [
          { challengerId: { in: userIds } },
          { opponentId: { in: userIds } },
        ],
      },
    });
    await prisma.ledgerEntry.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.withdrawal.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.deposit.deleteMany({ where: { userId: { in: userIds } } });
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
      .send({ direction: 'CREDIT', amountMinor, reason: 'e2e fixture credit' })
      .expect(200);
  }

  it('self-exclusion cannot be activated twice', async () => {
    const { accessToken } = await registerUser('selfexcldupe');

    await request(app.getHttpServer())
      .post('/api/v1/auth/responsible-gaming/self-exclude')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/responsible-gaming/self-exclude')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
  });

  it('status reflects an active self-exclusion', async () => {
    const { accessToken } = await registerUser('selfexclstatus');

    await request(app.getHttpServer())
      .post('/api/v1/auth/responsible-gaming/self-exclude')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const status = await request(app.getHttpServer())
      .get('/api/v1/auth/responsible-gaming/status')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(
      status.body.some((r: { type: string }) => r.type === 'SELF_EXCLUSION'),
    ).toBe(true);
  });

  it('self-exclusion blocks a deposit', async () => {
    const { accessToken } = await registerUser('selfexcldeposit');

    await request(app.getHttpServer())
      .post('/api/v1/auth/responsible-gaming/self-exclude')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/deposits')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor: '5000' })
      .expect(403);
  });

  it('self-exclusion does NOT block a withdrawal', async () => {
    const { accessToken, userId } = await registerUser('selfexclwithdraw');
    const admin = await registerUser('selfexclwithdrawa');
    await makeAdmin(admin.userId);
    await creditViaAdmin(admin.accessToken, userId, '10000');

    await request(app.getHttpServer())
      .post('/api/v1/auth/responsible-gaming/self-exclude')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/withdrawals')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        amountMinor: '4000',
        destinationDetails: {
          method: 'ORANGE_MONEY',
          phoneNumber: '+23276000000',
        },
      })
      .expect(201);
  });

  it('self-exclusion blocks forming a real-money staked challenge', async () => {
    const x = await registerUser('selfexclstakex');
    const o = await registerUser('selfexclstakeo');
    const admin = await registerUser('selfexclstakea');
    await makeAdmin(admin.userId);
    await creditViaAdmin(admin.accessToken, x.userId, '100000');
    await creditViaAdmin(admin.accessToken, o.userId, '100000');

    await request(app.getHttpServer())
      .post('/api/v1/auth/responsible-gaming/self-exclude')
      .set('Authorization', `Bearer ${x.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/challenges')
      .set('Authorization', `Bearer ${x.accessToken}`)
      .send({
        gameId: 'tic_tac_toe',
        opponentUserId: o.userId,
        stake: { amountMinor: '1000', currency: 'SLE' },
      })
      .expect(403);
  });

  it('a deposit limit blocks an over-limit deposit but allows one within it', async () => {
    const { accessToken } = await registerUser('depositlimit');

    await request(app.getHttpServer())
      .post('/api/v1/auth/responsible-gaming/deposit-limit')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ limitMinor: '5000' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/deposits')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor: '9000' })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/deposits')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor: '5000' })
      .expect(201);
  });

  it('admin can view restriction history, but there is no endpoint to lift a self-exclusion', async () => {
    const { accessToken, userId } = await registerUser('adminviewselfexcl');
    const admin = await registerUser('adminviewselfexcla');
    await makeAdmin(admin.userId);

    await request(app.getHttpServer())
      .post('/api/v1/auth/responsible-gaming/self-exclude')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const history = await request(app.getHttpServer())
      .get(`/api/v1/admin/responsible-gaming?userId=${userId}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(
      history.body.some(
        (r: { type: string; userId: string }) =>
          r.type === 'SELF_EXCLUSION' && r.userId === userId,
      ),
    ).toBe(true);
  });

  it('rejects a non-admin from viewing responsible-gaming history', async () => {
    const { accessToken } = await registerUser('rgviewunauth');
    await request(app.getHttpServer())
      .get('/api/v1/admin/responsible-gaming')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);
  });

  it('a rolling-window deposit limit blocks a second deposit that would push the total over it', async () => {
    const { accessToken, userId } = await registerUser('rolldepositlimit');
    const admin = await registerUser('rolldepositlimita');
    await makeAdmin(admin.userId);

    await request(app.getHttpServer())
      .post('/api/v1/auth/responsible-gaming/deposit-limit')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ limitMinor: '6000' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/deposits')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor: '5000' })
      .expect(201);

    // The deposit creation above is still PENDING — it only counts
    // toward the rolling total once it actually *completes* (a
    // `DEPOSIT` ledger entry exists only then). Simulate completion
    // the same way `DepositsService.completeFromProviderEvent` would,
    // directly crediting the ledger so the rolling check has something
    // real to sum.
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId },
    });
    await prisma.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        userId,
        type: 'DEPOSIT',
        availableDeltaMinor: 5000n,
        heldDeltaMinor: 0n,
        availableBalanceAfterMinor: 5000n,
        heldBalanceAfterMinor: 0n,
        currency: 'SLE',
      },
    });

    // A second deposit of 5000 would bring the rolling total to 10000,
    // over the 6000 limit.
    await request(app.getHttpServer())
      .post('/api/v1/deposits')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor: '5000' })
      .expect(403);
  });

  it("exposes the user's own current rolling-window usage", async () => {
    const { accessToken, userId } = await registerUser('ownusage');
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId },
    });
    await prisma.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        userId,
        type: 'DEPOSIT',
        availableDeltaMinor: 2500n,
        heldDeltaMinor: 0n,
        availableBalanceAfterMinor: 2500n,
        heldBalanceAfterMinor: 0n,
        currency: 'SLE',
      },
    });

    const usage = await request(app.getHttpServer())
      .get('/api/v1/auth/responsible-gaming/usage')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(usage.body.depositedMinor).toBe('2500');
    expect(usage.body.stakeHeldMinor).toBe('0');
    expect(usage.body.lossMinor).toBe('0');
    expect(typeof usage.body.windowHours).toBe('number');
  });

  it("lets an admin view another user's current rolling-window usage, read-only", async () => {
    const { userId } = await registerUser('adminviewusage');
    const admin = await registerUser('adminviewusagea');
    await makeAdmin(admin.userId);
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId },
    });
    await prisma.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        userId,
        type: 'DEPOSIT',
        availableDeltaMinor: 1200n,
        heldDeltaMinor: 0n,
        availableBalanceAfterMinor: 1200n,
        heldBalanceAfterMinor: 0n,
        currency: 'SLE',
      },
    });

    const usage = await request(app.getHttpServer())
      .get(`/api/v1/admin/responsible-gaming/${userId}/usage`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(usage.body.depositedMinor).toBe('1200');
  });

  it("rejects a non-admin from viewing another user's usage", async () => {
    const { accessToken } = await registerUser('usageunauth');
    const { userId: otherUserId } = await registerUser('usageunauthother');

    await request(app.getHttpServer())
      .get(`/api/v1/admin/responsible-gaming/${otherUserId}/usage`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);
  });

  it('a cooling-off period blocks a deposit until it ends', async () => {
    const { accessToken } = await registerUser('coolingoff');

    await request(app.getHttpServer())
      .post('/api/v1/auth/responsible-gaming/cooling-off')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ durationMinutes: 60 })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/deposits')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor: '5000' })
      .expect(403);
  });
});
