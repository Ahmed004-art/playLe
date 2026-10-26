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
import { PAYMENT_PROVIDER } from '../src/payments/ports/payment-provider.port.js';
import { FakePaymentProvider } from './fake-payment-provider.js';

/**
 * Phase 6: the real payout lifecycle (`APPROVED` → provider submission →
 * `PROCESSING` → webhook/synchronous resolution → `COMPLETED`/`FAILED`),
 * the `UNKNOWN`-outcome recovery path, and the deposit `EXPIRED` path.
 * Uses the same `FakePaymentProvider` double as `wallet.e2e-spec.ts` (the
 * only thing that can ever produce a *valid* signature), extended here
 * with `payoutScenario`/`depositScenario` controls.
 */
describe('Phase 6 payments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeProvider: FakePaymentProvider;
  const runId = randomUUID().slice(0, 8);

  const email = (label: string) => `${label}-${runId}@example.com`;
  const username = (label: string) => `${label}${runId}`.slice(0, 20);

  beforeAll(async () => {
    fakeProvider = new FakePaymentProvider();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(fakeProvider)
      .compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
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

  afterEach(() => {
    fakeProvider.depositScenario = 'pending';
    fakeProvider.payoutScenario = 'pending';
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { contains: runId } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    await prisma.providerOperation.deleteMany({
      where: {
        OR: [
          { deposit: { userId: { in: userIds } } },
          { withdrawal: { userId: { in: userIds } } },
        ],
      },
    });
    await prisma.ledgerEntry.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.providerEvent.deleteMany({
      where: {
        OR: [
          { deposit: { userId: { in: userIds } } },
          { withdrawal: { userId: { in: userIds } } },
        ],
      },
    });
    await prisma.withdrawal.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.deposit.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({
      where: { userId: { in: userIds } },
    });
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

  async function setupFundedUser(
    label: string,
    amountMinor: string,
  ): Promise<{ accessToken: string; userId: string; adminToken: string }> {
    const { accessToken, userId } = await registerUser(label);
    const admin = await registerUser(`${label}adm`);
    await makeAdmin(admin.userId);
    await creditViaAdmin(admin.accessToken, userId, amountMinor);
    return { accessToken, userId, adminToken: admin.accessToken };
  }

  async function createWithdrawal(
    accessToken: string,
    amountMinor: string,
  ): Promise<{ id: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/withdrawals')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        amountMinor,
        destinationDetails: {
          method: 'ORANGE_MONEY',
          phoneNumber: '+23276000000',
        },
      })
      .expect(201);
    return { id: res.body.id as string };
  }

  describe('deposits — Payment Code instructions and expiry', () => {
    it('returns provider-facing payment instructions on creation', async () => {
      const { accessToken } = await registerUser('depinstr');

      const created = await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '5000' })
        .expect(201);

      expect(created.body.paymentInstructions).toMatchObject({
        ussdCode: expect.any(String),
      });

      const fetched = await request(app.getHttpServer())
        .get(`/api/v1/deposits/${created.body.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(fetched.body.paymentInstructions).toMatchObject({
        ussdCode: expect.any(String),
      });
    });

    it('a network error during initiation leaves the deposit PENDING, recorded as UNKNOWN', async () => {
      fakeProvider.depositScenario = 'network_error';
      const { accessToken } = await registerUser('depnet');

      const created = await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '5000' })
        .expect(201);

      expect(created.body.status).toBe('PENDING');

      const operation = await prisma.providerOperation.findFirst({
        where: { relatedDepositId: created.body.id },
      });
      expect(operation?.status).toBe('UNKNOWN');
    });

    it('a deposit.expired webhook marks the deposit EXPIRED with no ledger effect', async () => {
      const { accessToken, userId } = await registerUser('depexpired');

      const created = await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '5000' })
        .expect(201);

      const body = fakeProvider.buildWebhookBody({
        eventType: 'deposit.expired',
        providerReference: created.body.providerReference,
      });

      await request(app.getHttpServer())
        .post('/api/v1/payments/webhooks/monime')
        .set('x-fake-signature', fakeProvider.signatureHeader())
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);

      const deposit = await prisma.deposit.findUnique({
        where: { id: created.body.id },
      });
      expect(deposit?.status).toBe('EXPIRED');

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      expect(wallet?.availableBalanceMinor).toBe(0n);
    });
  });

  describe('withdrawals — real payout lifecycle', () => {
    it('approve submits a payout and moves the withdrawal to PROCESSING with a provider reference', async () => {
      const { accessToken, adminToken } = await setupFundedUser(
        'wdprocessing',
        '10000',
      );
      const { id } = await createWithdrawal(accessToken, '4000');

      const approved = await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Verified identity' })
        .expect(200);

      expect(approved.body.status).toBe('PROCESSING');
      expect(approved.body.providerReference).toMatch(/^fake_payout_/);

      const operation = await prisma.providerOperation.findFirst({
        where: { relatedWithdrawalId: id, kind: 'PAYOUT_SUBMIT' },
      });
      expect(operation?.status).toBe('PENDING');
    });

    it('a payout.completed webhook finalizes the withdrawal and permanently removes the hold', async () => {
      const { accessToken, userId, adminToken } = await setupFundedUser(
        'wdpayoutok',
        '10000',
      );
      const { id } = await createWithdrawal(accessToken, '4000');

      const approved = await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Verified identity' })
        .expect(200);
      expect(approved.body.status).toBe('PROCESSING');

      const body = fakeProvider.buildPayoutWebhookBody({
        eventType: 'payout.completed',
        providerReference: approved.body.providerReference,
      });

      await request(app.getHttpServer())
        .post('/api/v1/payments/webhooks/monime')
        .set('x-fake-signature', fakeProvider.signatureHeader())
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);

      const withdrawal = await prisma.withdrawal.findUnique({
        where: { id },
      });
      expect(withdrawal?.status).toBe('COMPLETED');

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      expect(wallet?.availableBalanceMinor).toBe(6000n);
      expect(wallet?.heldBalanceMinor).toBe(0n);
    });

    it('a payout.failed webhook releases the hold back to available', async () => {
      const { accessToken, userId, adminToken } = await setupFundedUser(
        'wdpayoutfail',
        '10000',
      );
      const { id } = await createWithdrawal(accessToken, '4000');

      const approved = await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Verified identity' })
        .expect(200);

      const body = fakeProvider.buildPayoutWebhookBody({
        eventType: 'payout.failed',
        providerReference: approved.body.providerReference,
        reason: 'Provider account blocked',
      });

      await request(app.getHttpServer())
        .post('/api/v1/payments/webhooks/monime')
        .set('x-fake-signature', fakeProvider.signatureHeader())
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);

      const withdrawal = await prisma.withdrawal.findUnique({
        where: { id },
      });
      expect(withdrawal?.status).toBe('FAILED');
      expect(withdrawal?.failureReason).toMatch(/blocked/i);

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      expect(wallet?.availableBalanceMinor).toBe(10000n);
      expect(wallet?.heldBalanceMinor).toBe(0n);
    });

    it('a provider that answers synchronously with SUCCEEDED completes the withdrawal immediately', async () => {
      fakeProvider.payoutScenario = 'succeeded';
      const { accessToken, userId, adminToken } = await setupFundedUser(
        'wdsync',
        '10000',
      );
      const { id } = await createWithdrawal(accessToken, '4000');

      const approved = await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Verified identity' })
        .expect(200);

      expect(approved.body.status).toBe('COMPLETED');

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      expect(wallet?.availableBalanceMinor).toBe(6000n);
      expect(wallet?.heldBalanceMinor).toBe(0n);
    });

    it('a network error during submission leaves funds held and the withdrawal PROCESSING, recorded as UNKNOWN — never a silent retry', async () => {
      fakeProvider.payoutScenario = 'network_error';
      const { accessToken, userId, adminToken } = await setupFundedUser(
        'wdunknown',
        '10000',
      );
      const { id } = await createWithdrawal(accessToken, '4000');

      const approved = await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Verified identity' })
        .expect(200);

      expect(approved.body.status).toBe('PROCESSING');

      const operation = await prisma.providerOperation.findFirst({
        where: { relatedWithdrawalId: id, kind: 'PAYOUT_SUBMIT' },
      });
      expect(operation?.status).toBe('UNKNOWN');

      // Funds stay held — neither released nor paid out — until the
      // admin resolves it (reconciliation/manual `complete`/`fail`).
      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      expect(wallet?.availableBalanceMinor).toBe(6000n);
      expect(wallet?.heldBalanceMinor).toBe(4000n);

      // The admin resolves it by hand after reconciling out-of-band —
      // `complete`/`fail` now accept PROCESSING, not just APPROVED.
      const resolved = await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${id}/complete`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Confirmed with provider support out-of-band' })
        .expect(200);
      expect(resolved.body.status).toBe('COMPLETED');
    });

    it('when the provider is unavailable, approval leaves the withdrawal APPROVED for the existing manual flow', async () => {
      fakeProvider.payoutScenario = 'unavailable';
      const { accessToken, adminToken } = await setupFundedUser(
        'wdmanualfallback',
        '10000',
      );
      const { id } = await createWithdrawal(accessToken, '4000');

      const approved = await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Verified identity' })
        .expect(200);

      expect(approved.body.status).toBe('APPROVED');

      await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${id}/complete`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Payout sent manually' })
        .expect(200);
    });

    it('a duplicate payout webhook delivery is ignored and never double-releases the hold', async () => {
      const { accessToken, userId, adminToken } = await setupFundedUser(
        'wddupe',
        '10000',
      );
      const { id } = await createWithdrawal(accessToken, '4000');

      const approved = await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Verified identity' })
        .expect(200);

      const body = fakeProvider.buildPayoutWebhookBody({
        eventId: 'dupe-event-1',
        eventType: 'payout.completed',
        providerReference: approved.body.providerReference,
      });

      for (let i = 0; i < 2; i += 1) {
        await request(app.getHttpServer())
          .post('/api/v1/payments/webhooks/monime')
          .set('x-fake-signature', fakeProvider.signatureHeader())
          .set('Content-Type', 'application/json')
          .send(body)
          .expect(200);
      }

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      expect(wallet?.availableBalanceMinor).toBe(6000n);
      expect(wallet?.heldBalanceMinor).toBe(0n);
    });

    it('rejects a webhook with an invalid signature', async () => {
      const { accessToken, adminToken } = await setupFundedUser(
        'wdbadsig',
        '10000',
      );
      const { id } = await createWithdrawal(accessToken, '4000');

      const approved = await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Verified identity' })
        .expect(200);

      const body = fakeProvider.buildPayoutWebhookBody({
        eventType: 'payout.completed',
        providerReference: approved.body.providerReference,
      });

      // 401, not 200: nothing is recorded for an unauthenticated delivery, so it
      // must not be acknowledged (the sender would never retry it).
      await request(app.getHttpServer())
        .post('/api/v1/payments/webhooks/monime')
        .set('x-fake-signature', 'not-the-real-secret')
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(401);

      const withdrawal = await prisma.withdrawal.findUnique({
        where: { id },
      });
      expect(withdrawal?.status).toBe('PROCESSING');
    });
  });

  describe('payment reconciliation', () => {
    it('detects and persists an UNKNOWN_PAYOUT_OUTCOME anomaly for a withdrawal stuck after a network error', async () => {
      fakeProvider.payoutScenario = 'network_error';
      const { accessToken, adminToken } = await setupFundedUser(
        'wdrecon',
        '10000',
      );
      const { id } = await createWithdrawal(accessToken, '4000');

      await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Verified identity' })
        .expect(200);

      const report = await request(app.getHttpServer())
        .get('/api/v1/admin/payment-reconciliation/run')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const found = report.body.anomalies.find(
        (a: { type: string; relatedWithdrawalId?: string }) =>
          a.type === 'UNKNOWN_PAYOUT_OUTCOME' && a.relatedWithdrawalId === id,
      );
      expect(found).toBeDefined();

      const list = await request(app.getHttpServer())
        .get('/api/v1/admin/payment-reconciliation/anomalies?status=OPEN')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const persisted = list.body.items.find(
        (a: { type: string; relatedWithdrawalId?: string }) =>
          a.type === 'UNKNOWN_PAYOUT_OUTCOME' && a.relatedWithdrawalId === id,
      );
      expect(persisted).toBeDefined();

      // A second run does not create a duplicate OPEN row for the same issue.
      const secondRun = await request(app.getHttpServer())
        .get('/api/v1/admin/payment-reconciliation/run')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const stillOpenCount = (
        secondRun.body.anomalies as Array<{
          type: string;
          relatedWithdrawalId?: string;
        }>
      ).filter(
        (a) =>
          a.type === 'UNKNOWN_PAYOUT_OUTCOME' && a.relatedWithdrawalId === id,
      ).length;
      expect(stillOpenCount).toBe(1);

      const resolved = await request(app.getHttpServer())
        .post(
          `/api/v1/admin/payment-reconciliation/anomalies/${persisted.id}/resolve`,
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ resolutionNote: 'Confirmed with provider support out-of-band' })
        .expect(200);
      expect(resolved.body.status).toBe('RESOLVED');
    });

    it('surfaces a rejected completion as an AMOUNT_MISMATCH anomaly until a valid event completes the deposit', async () => {
      const { accessToken, userId, adminToken } = await setupFundedUser(
        'amtrecon',
        '1000',
      );
      const created = await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '5000' })
        .expect(201);
      const depositId = created.body.id as string;
      const providerReference = created.body.providerReference as string;

      const deliver = (
        reported: { amountMinor: string; currency: string },
        // Pass the same id to replay a delivery verbatim. Only included when
        // set: an explicit `eventId: undefined` would override the helper's
        // random one.
        eventId?: string,
      ) =>
        request(app.getHttpServer())
          .post('/api/v1/payments/webhooks/monime')
          .set('x-fake-signature', fakeProvider.signatureHeader())
          .set('Content-Type', 'application/json')
          .send(
            fakeProvider.buildWebhookBody({
              ...(eventId ? { eventId } : {}),
              eventType: 'deposit.completed',
              providerReference,
              ...reported,
            }),
          );
      const mismatches = async () => {
        const report = await request(app.getHttpServer())
          .get('/api/v1/admin/payment-reconciliation/run')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        return (
          report.body.anomalies as Array<{
            type: string;
            relatedDepositId?: string;
          }>
        ).filter(
          (a) =>
            a.type === 'AMOUNT_MISMATCH' && a.relatedDepositId === depositId,
        );
      };

      // A completion for the wrong amount is rejected, nothing is credited,
      // and the deposit stays PENDING - not FAILED, not refunded.
      const badEventId = randomUUID();
      const bad = await deliver(
        { amountMinor: '1', currency: 'SLE' },
        badEventId,
      ).expect(200);
      expect(bad.body.status).toBe('rejected');
      expect(
        (await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } }))
          .status,
      ).toBe('PENDING');
      expect(
        await prisma.ledgerEntry.count({
          where: { relatedDepositId: depositId },
        }),
      ).toBe(0);

      // Operators see it: reported once, persisted OPEN, and a re-run does
      // not duplicate it. A second rejected event does not add a second row.
      expect(await mismatches()).toHaveLength(1);

      // Replaying the very same rejected event is ignored: no second event
      // row and no second anomaly.
      const replay = await deliver(
        { amountMinor: '1', currency: 'SLE' },
        badEventId,
      ).expect(200);
      expect(replay.body.status).toBe('ignored');
      expect(
        await prisma.providerEvent.count({
          where: { providerEventId: badEventId },
        }),
      ).toBe(1);
      expect(await mismatches()).toHaveLength(1);

      await deliver({ amountMinor: '5000', currency: 'USD' }).expect(200);
      expect(await mismatches()).toHaveLength(1);
      const list = await request(app.getHttpServer())
        .get('/api/v1/admin/payment-reconciliation/anomalies?status=OPEN')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(
        (
          list.body.items as Array<{ type: string; relatedDepositId?: string }>
        ).filter(
          (a) =>
            a.type === 'AMOUNT_MISMATCH' && a.relatedDepositId === depositId,
        ),
      ).toHaveLength(1);

      // A later valid event still completes the deposit exactly once, and the
      // deposit is no longer reported.
      const good = await deliver({
        amountMinor: '5000',
        currency: 'SLE',
      }).expect(200);
      expect(good.body.status).toBe('processed');
      expect(
        (await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } }))
          .status,
      ).toBe('COMPLETED');
      expect(
        await prisma.ledgerEntry.count({
          where: { relatedDepositId: depositId, type: 'DEPOSIT' },
        }),
      ).toBe(1);
      expect(await mismatches()).toHaveLength(0);
      void userId;
    }, 30000);

    it('rejects a non-admin attempting to run reconciliation', async () => {
      const { accessToken } = await registerUser('wdreconunauth');
      await request(app.getHttpServer())
        .get('/api/v1/admin/payment-reconciliation/run')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });
  });

  describe('admin provider-operation / webhook-event visibility', () => {
    it('lists provider operations and events for a withdrawal payout submission', async () => {
      const { accessToken, userId, adminToken } = await setupFundedUser(
        'wdprovview',
        '10000',
      );
      const { id } = await createWithdrawal(accessToken, '4000');

      await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Verified identity' })
        .expect(200);

      const operations = await request(app.getHttpServer())
        .get(`/api/v1/admin/provider-operations?userId=${userId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(
        operations.body.items.some(
          (op: { kind: string }) => op.kind === 'PAYOUT_SUBMIT',
        ),
      ).toBe(true);

      const body = fakeProvider.buildPayoutWebhookBody({
        eventType: 'payout.completed',
        providerReference: `fake_payout_${id}`,
      });
      await request(app.getHttpServer())
        .post('/api/v1/payments/webhooks/monime')
        .set('x-fake-signature', fakeProvider.signatureHeader())
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);

      const events = await request(app.getHttpServer())
        .get('/api/v1/admin/provider-events')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(
        events.body.items.some(
          (e: { eventType: string }) => e.eventType === 'payout.completed',
        ),
      ).toBe(true);
    });

    it('rejects a non-admin from listing provider operations', async () => {
      const { accessToken } = await registerUser('wdprovviewunauth');
      await request(app.getHttpServer())
        .get('/api/v1/admin/provider-operations')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });
  });
});
