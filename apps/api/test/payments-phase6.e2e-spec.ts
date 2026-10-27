import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { LedgerService } from '../src/ledger/ledger.service.js';
import { WithdrawalsService } from '../src/withdrawals/withdrawals.service.js';
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

  describe('recovering webhook deliveries that failed part-way (Phase 13)', () => {
    const postWebhook = (body: string) =>
      request(app.getHttpServer())
        .post('/api/v1/payments/webhooks/monime')
        .set('x-fake-signature', fakeProvider.signatureHeader())
        .set('Content-Type', 'application/json')
        .send(body);

    it('a deposit completion whose credit failed is recovered by the redelivery and credited exactly once', async () => {
      const { accessToken, userId } = await registerUser('deprecover');
      const created = await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '5000' })
        .expect(201);
      const eventId = `recover-dep-${runId}`;
      const body = fakeProvider.buildWebhookBody({
        eventId,
        eventType: 'deposit.completed',
        providerReference: created.body.providerReference,
      });

      // The credit transaction fails once (a real rollback in Postgres).
      const ledger = app.get(LedgerService);
      const spy = vi
        .spyOn(ledger, 'applyEntry')
        .mockRejectedValueOnce(new Error('injected transient failure'));
      try {
        // Not acknowledged, so the provider retries.
        await postWebhook(body).expect(500);
      } finally {
        spy.mockRestore();
      }

      expect(
        (await prisma.deposit.findUnique({ where: { id: created.body.id } }))
          ?.status,
      ).toBe('PENDING');
      expect(
        (await prisma.wallet.findUnique({ where: { userId } }))
          ?.availableBalanceMinor,
      ).toBe(0n);
      expect(
        (
          await prisma.providerEvent.findUnique({
            where: {
              provider_providerEventId: {
                provider: 'FAKE',
                providerEventId: eventId,
              },
            },
          })
        )?.status,
      ).toBe('RECEIVED');

      // The provider's retry: the same event, now processed.
      await postWebhook(body).expect(200);
      // And any later duplicate is a no-op.
      await postWebhook(body).expect(200);

      expect(
        (await prisma.deposit.findUnique({ where: { id: created.body.id } }))
          ?.status,
      ).toBe('COMPLETED');
      expect(
        (await prisma.wallet.findUnique({ where: { userId } }))
          ?.availableBalanceMinor,
      ).toBe(5000n);
      expect(
        await prisma.ledgerEntry.count({
          where: { relatedDepositId: created.body.id, type: 'DEPOSIT' },
        }),
      ).toBe(1);
      const event = await prisma.providerEvent.findUnique({
        where: {
          provider_providerEventId: {
            provider: 'FAKE',
            providerEventId: eventId,
          },
        },
      });
      expect(event?.status).toBe('PROCESSED');
      expect(event?.relatedDepositId).toBe(created.body.id);
    });

    it('a payout completion whose ledger write failed is recovered by the redelivery and finalized once', async () => {
      const { accessToken, userId, adminToken } = await setupFundedUser(
        'wdrecover',
        '10000',
      );
      const { id } = await createWithdrawal(accessToken, '4000');
      const approved = await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Verified identity' })
        .expect(200);
      const eventId = `recover-wd-${runId}`;
      const body = fakeProvider.buildPayoutWebhookBody({
        eventId,
        eventType: 'payout.completed',
        providerReference: approved.body.providerReference,
      });

      const ledger = app.get(LedgerService);
      const spy = vi
        .spyOn(ledger, 'applyEntry')
        .mockRejectedValueOnce(new Error('injected transient failure'));
      try {
        await postWebhook(body).expect(500);
      } finally {
        spy.mockRestore();
      }
      expect(
        (await prisma.withdrawal.findUnique({ where: { id } }))?.status,
      ).toBe('PROCESSING');

      await postWebhook(body).expect(200);
      await postWebhook(body).expect(200);

      expect(
        (await prisma.withdrawal.findUnique({ where: { id } }))?.status,
      ).toBe('COMPLETED');
      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      expect(wallet?.availableBalanceMinor).toBe(6000n);
      expect(wallet?.heldBalanceMinor).toBe(0n);
      expect(
        await prisma.ledgerEntry.count({
          where: { relatedWithdrawalId: id, type: 'WITHDRAWAL' },
        }),
      ).toBe(1);
      expect(
        (
          await prisma.providerEvent.findUnique({
            where: {
              provider_providerEventId: {
                provider: 'FAKE',
                providerEventId: eventId,
              },
            },
          })
        )?.status,
      ).toBe('PROCESSED');
    });

    it('competing payout.completed and payout.failed deliveries apply exactly one outcome', async () => {
      // Two withdrawals hold 8000 of 10000, so the held balance alone could
      // cover both a debit and a release of the first one: only the claim
      // stops a double outcome.
      const { accessToken, userId, adminToken } = await setupFundedUser(
        'wdrace',
        '10000',
      );
      const { id } = await createWithdrawal(accessToken, '4000');
      await createWithdrawal(accessToken, '4000');
      const approved = await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Verified identity' })
        .expect(200);
      const reference = approved.body.providerReference as string;

      const responses = await Promise.all([
        postWebhook(
          fakeProvider.buildPayoutWebhookBody({
            eventType: 'payout.completed',
            providerReference: reference,
          }),
        ),
        postWebhook(
          fakeProvider.buildPayoutWebhookBody({
            eventType: 'payout.failed',
            providerReference: reference,
            reason: 'bounced',
          }),
        ),
      ]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);

      const withdrawal = await prisma.withdrawal.findUnique({ where: { id } });
      const outcomes = await prisma.ledgerEntry.findMany({
        where: {
          relatedWithdrawalId: id,
          type: { in: ['WITHDRAWAL', 'RELEASE'] },
        },
      });
      expect(outcomes).toHaveLength(1);
      expect(withdrawal?.status).toBe(
        outcomes[0].type === 'WITHDRAWAL' ? 'COMPLETED' : 'FAILED',
      );

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      // The other withdrawal's hold is untouched.
      expect(wallet?.heldBalanceMinor).toBe(4000n);
      expect(wallet?.availableBalanceMinor).toBe(
        outcomes[0].type === 'WITHDRAWAL' ? 2000n : 6000n,
      );
    });
  });

  describe('withdrawal review decisions racing each other (Phase 13)', () => {
    /**
     * Holds the first read of a withdrawal by `approve`/`reject` (findByIdAdmin)
     * or `cancel` (findById): the caller has seen PENDING_REVIEW and is parked
     * before it writes anything, while the test runs the rival decision to
     * completion, then releases it. No sleeps: the interleaving is forced.
     */
    function parkAfterRead(method: 'findByIdAdmin' | 'findById') {
      const service = app.get(WithdrawalsService);
      type Reader = (...args: string[]) => Promise<unknown>;
      const original = (service[method] as Reader).bind(service);
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((r) => (reached = r));
      const released = new Promise<void>((r) => (release = r));
      const spy = vi.spyOn(service, method).mockImplementationOnce((async (
        ...args: string[]
      ) => {
        const row = await original(...args);
        reached();
        await released;
        return row;
      }) as never);
      return {
        reached: reachedPromise,
        release,
        restore: () => spy.mockRestore(),
      };
    }

    /** Records the committed status of every withdrawal a payout is submitted for. */
    function watchPayouts() {
      const submittedWhile: string[] = [];
      const original = fakeProvider.initiatePayout.bind(fakeProvider);
      const spy = vi
        .spyOn(fakeProvider, 'initiatePayout')
        .mockImplementation(async (params) => {
          // A separate query: it sees only committed state, so this is what a
          // payout provider's callback could rely on at this moment.
          const row = await prisma.withdrawal.findUnique({
            where: { id: params.withdrawalId },
          });
          submittedWhile.push(row?.status ?? 'missing');
          return original(params);
        });
      return { submittedWhile, restore: () => spy.mockRestore() };
    }

    /** A funded user with the withdrawal under test and a larger, unrelated hold. */
    async function userWithPendingWithdrawal(label: string) {
      const { accessToken, userId } = await setupFundedUser(label, '10000');
      const admin = await prisma.user.findUniqueOrThrow({
        where: { email: email(`${label}adm`) },
      });
      const { id } = await createWithdrawal(accessToken, '4000');
      // 5000 of this wallet's funds are held for another withdrawal, so a hold
      // released twice would take that money rather than fail.
      await createWithdrawal(accessToken, '5000');
      return { userId, adminId: admin.id, id };
    }

    const entryTypes = async (withdrawalId: string) =>
      (
        await prisma.ledgerEntry.findMany({
          where: { relatedWithdrawalId: withdrawalId },
          orderBy: { createdAt: 'asc' },
        })
      ).map((e) => e.type);

    const walletOf = async (userId: string) => {
      const w = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
      return { available: w.availableBalanceMinor, held: w.heldBalanceMinor };
    };

    const settle = (promise: Promise<unknown>) =>
      promise.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    type Decision = 'approve' | 'cancel' | 'reject';
    type Ids = { userId: string; adminId: string; id: string };
    const run = (decision: Decision, ids: Ids) => {
      const service = app.get(WithdrawalsService);
      switch (decision) {
        case 'approve':
          return service.approve(ids.adminId, ids.id, 'Verified identity');
        case 'cancel':
          return service.cancel(ids.userId, ids.id);
        case 'reject':
          return service.reject(ids.adminId, ids.id, 'Not eligible');
      }
    };

    /** `stale` has already read PENDING_REVIEW; `winner` completes first. */
    async function race(stale: Decision, winner: Decision, ids: Ids) {
      const parked = parkAfterRead(
        stale === 'cancel' ? 'findById' : 'findByIdAdmin',
      );
      try {
        const stalePromise = settle(run(stale, ids));
        await parked.reached;
        const winnerOutcome = await settle(run(winner, ids));
        parked.release();
        return { stale: await stalePromise, winner: winnerOutcome };
      } finally {
        parked.restore();
      }
    }

    const expectConflict = (outcome: { ok: boolean; error?: unknown }) => {
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBeInstanceOf(ConflictException);
    };

    const statusOf = async (id: string) =>
      (await prisma.withdrawal.findUnique({ where: { id } }))?.status;

    it('cancel wins, then a stale approval submits no payout and does not resurrect the withdrawal', async () => {
      const ids = await userWithPendingWithdrawal('racecanc1');
      const payouts = watchPayouts();
      try {
        const result = await race('approve', 'cancel', ids);

        expect(result.winner.ok).toBe(true);
        expect(payouts.submittedWhile).toEqual([]);
        expect(await statusOf(ids.id)).toBe('CANCELLED');
        expect(await entryTypes(ids.id)).toEqual(['HOLD', 'RELEASE']);
        expect(await walletOf(ids.userId)).toEqual({
          available: 5000n,
          held: 5000n,
        });
        expectConflict(result.stale);
      } finally {
        payouts.restore();
      }
    });

    it('approval wins and pays out, then a stale cancel does not release the hold', async () => {
      const ids = await userWithPendingWithdrawal('racecanc2');
      const payouts = watchPayouts();
      try {
        const result = await race('cancel', 'approve', ids);

        expect(result.winner.ok).toBe(true);
        // One payout, submitted only once the approval was committed.
        expect(payouts.submittedWhile).toEqual(['APPROVED']);
        expect(await statusOf(ids.id)).toBe('PROCESSING');
        expect(await entryTypes(ids.id)).toEqual(['HOLD']);
        expect(await walletOf(ids.userId)).toEqual({
          available: 1000n,
          held: 9000n,
        });
        expectConflict(result.stale);
      } finally {
        payouts.restore();
      }
    });

    it('reject wins, then a stale approval submits no payout and does not resurrect the withdrawal', async () => {
      const ids = await userWithPendingWithdrawal('racerej1');
      const payouts = watchPayouts();
      try {
        const result = await race('approve', 'reject', ids);

        expect(result.winner.ok).toBe(true);
        expect(payouts.submittedWhile).toEqual([]);
        expect(await statusOf(ids.id)).toBe('REJECTED');
        expect(await entryTypes(ids.id)).toEqual(['HOLD', 'RELEASE']);
        expect(await walletOf(ids.userId)).toEqual({
          available: 5000n,
          held: 5000n,
        });
        expectConflict(result.stale);
      } finally {
        payouts.restore();
      }
    });

    it('approval wins and pays out, then a stale rejection does not release the hold', async () => {
      const ids = await userWithPendingWithdrawal('racerej2');
      const payouts = watchPayouts();
      try {
        const result = await race('reject', 'approve', ids);

        expect(result.winner.ok).toBe(true);
        expect(payouts.submittedWhile).toEqual(['APPROVED']);
        expect(await statusOf(ids.id)).toBe('PROCESSING');
        expect(await entryTypes(ids.id)).toEqual(['HOLD']);
        expect(await walletOf(ids.userId)).toEqual({
          available: 1000n,
          held: 9000n,
        });
        expectConflict(result.stale);
      } finally {
        payouts.restore();
      }
    });

    it.each([
      ['reject', 'cancel'],
      ['cancel', 'reject'],
    ] as const)(
      'a stale %s after a winning %s releases the hold only once',
      async (stale, winner) => {
        const ids = await userWithPendingWithdrawal(`racerel${stale}`);

        const result = await race(stale, winner, ids);

        expect(result.winner.ok).toBe(true);
        expect(await entryTypes(ids.id)).toEqual(['HOLD', 'RELEASE']);
        // The unrelated 5000 hold is intact: a second release would have
        // returned 4000 of it to the available balance.
        expect(await walletOf(ids.userId)).toEqual({
          available: 5000n,
          held: 5000n,
        });
        expectConflict(result.stale);
      },
    );

    /**
     * `approve` has committed and its payout request is in flight (parked in the
     * fake provider, the withdrawal still APPROVED in the database); `finalise`
     * then runs to completion; only then does the provider's answer return.
     */
    async function finaliseWhilePayoutInFlight(
      ids: Ids,
      finalise: () => Promise<unknown>,
    ) {
      const original = fakeProvider.initiatePayout.bind(fakeProvider);
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((r) => (reached = r));
      const released = new Promise<void>((r) => (release = r));
      const spy = vi
        .spyOn(fakeProvider, 'initiatePayout')
        .mockImplementationOnce(async (params) => {
          reached();
          await released;
          return original(params);
        });
      try {
        const approval = settle(run('approve', ids));
        await reachedPromise;
        expect(await statusOf(ids.id)).toBe('APPROVED');
        const admin = await settle(finalise());
        release();
        return { approval: await approval, admin };
      } finally {
        spy.mockRestore();
      }
    }

    it('an admin completion while the payout request is in flight is not overwritten, and the payout event debits nothing more', async () => {
      const ids = await userWithPendingWithdrawal('payinflight1');
      const reference = `fake_payout_${ids.id}`;

      const result = await finaliseWhilePayoutInFlight(ids, () =>
        app
          .get(WithdrawalsService)
          .complete(ids.adminId, ids.id, 'Paid by hand', reference),
      );

      expect(result.admin.ok).toBe(true);
      expect(result.approval.ok).toBe(true);
      expect(await statusOf(ids.id)).toBe('COMPLETED');
      expect(await entryTypes(ids.id)).toEqual(['HOLD', 'WITHDRAWAL']);

      // The provider's own completion event for that reference then arrives.
      await request(app.getHttpServer())
        .post('/api/v1/payments/webhooks/monime')
        .set('x-fake-signature', fakeProvider.signatureHeader())
        .set('Content-Type', 'application/json')
        .send(
          fakeProvider.buildPayoutWebhookBody({
            eventType: 'payout.completed',
            providerReference: reference,
          }),
        )
        .expect(200);

      expect(await statusOf(ids.id)).toBe('COMPLETED');
      expect(await entryTypes(ids.id)).toEqual(['HOLD', 'WITHDRAWAL']);
      // Only this withdrawal's 4000 left the held balance; the other 5000 hold
      // is untouched.
      expect(await walletOf(ids.userId)).toEqual({
        available: 1000n,
        held: 5000n,
      });
    });

    it('an admin failure while the payout request is in flight is not overwritten when the provider then answers SUCCEEDED', async () => {
      const ids = await userWithPendingWithdrawal('payinflight2');
      fakeProvider.payoutScenario = 'succeeded';

      const result = await finaliseWhilePayoutInFlight(ids, () =>
        app.get(WithdrawalsService).fail(ids.adminId, ids.id, 'Could not pay'),
      );

      expect(result.admin.ok).toBe(true);
      expect(await statusOf(ids.id)).toBe('FAILED');
      // Released once, never also debited.
      expect(await entryTypes(ids.id)).toEqual(['HOLD', 'RELEASE']);
      expect(await walletOf(ids.userId)).toEqual({
        available: 5000n,
        held: 5000n,
      });
      // The attempt is still on record as what the provider answered.
      const operations = await prisma.providerOperation.findMany({
        where: { relatedWithdrawalId: ids.id },
      });
      expect(operations.map((o) => o.status)).toEqual(['SUCCEEDED']);
    });

    it('unsynchronised approve and cancel, repeated, always end in exactly one consistent outcome', async () => {
      const { accessToken, userId } = await setupFundedUser(
        'racerepeat',
        '10000',
      );
      const admin = await prisma.user.findUniqueOrThrow({
        where: { email: email('racerepeatadm') },
      });
      const service = app.get(WithdrawalsService);
      const payouts = watchPayouts();
      try {
        for (let round = 0; round < 6; round += 1) {
          const { id } = await createWithdrawal(accessToken, '1000');
          payouts.submittedWhile.length = 0;

          const [approval, cancellation] = await Promise.all([
            settle(service.approve(admin.id, id, 'ok')),
            settle(service.cancel(userId, id)),
          ]);

          const status = await statusOf(id);
          const entries = await entryTypes(id);
          if (approval.ok) {
            // Approval won: the hold stays, one payout, cancel refused.
            expectConflict(cancellation);
            expect(status).toBe('PROCESSING');
            expect(entries).toEqual(['HOLD']);
            expect(payouts.submittedWhile).toEqual(['APPROVED']);
          } else {
            // Cancellation won: hold released once, no payout, approve refused.
            expectConflict(approval);
            expect(cancellation.ok).toBe(true);
            expect(status).toBe('CANCELLED');
            expect(entries).toEqual(['HOLD', 'RELEASE']);
            expect(payouts.submittedWhile).toEqual([]);
          }
        }
      } finally {
        payouts.restore();
      }
    });
  });

  describe('stale RECEIVED provider events (Phase 13)', () => {
    const THIRTY_MINUTES_MS = 30 * 60_000;

    const postWebhook = (body: string) =>
      request(app.getHttpServer())
        .post('/api/v1/payments/webhooks/monime')
        .set('x-fake-signature', fakeProvider.signatureHeader())
        .set('Content-Type', 'application/json')
        .send(body);

    const runReconciliation = async (adminToken: string) => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/payment-reconciliation/run')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      return res.body as {
        anomalies: Array<{
          type: string;
          relatedDepositId?: string;
          eventKey?: string;
          detail: string;
        }>;
        newlyRecorded: number;
      };
    };

    const staleFor = (
      report: Awaited<ReturnType<typeof runReconciliation>>,
      depositId: string,
    ) =>
      report.anomalies.filter(
        (a) =>
          a.type === 'STALE_PROVIDER_EVENT' && a.relatedDepositId === depositId,
      );

    const openStaleRows = (depositId: string) =>
      prisma.paymentReconciliationAnomaly.findMany({
        where: {
          type: 'STALE_PROVIDER_EVENT',
          status: 'OPEN',
          relatedDepositId: depositId,
        },
      });

    const eventRow = (eventId: string) =>
      prisma.providerEvent.findUnique({
        where: {
          provider_providerEventId: {
            provider: 'FAKE',
            providerEventId: eventId,
          },
        },
      });

    const backdate = (eventId: string, ageMs: number) =>
      prisma.providerEvent.update({
        where: {
          provider_providerEventId: {
            provider: 'FAKE',
            providerEventId: eventId,
          },
        },
        data: { createdAt: new Date(Date.now() - ageMs) },
      });

    /** A pending deposit, plus the completion webhook body for it. */
    async function depositWithCompletion(label: string, eventId: string) {
      const { accessToken, userId, adminToken } = await setupFundedUser(
        label,
        '1000',
      );
      const created = await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '5000' })
        .expect(201);
      const completion = (amountMinor?: string) =>
        fakeProvider.buildWebhookBody({
          eventId,
          eventType: 'deposit.completed',
          providerReference: created.body.providerReference,
          ...(amountMinor ? { amountMinor, currency: 'SLE' } : {}),
        });
      return {
        userId,
        adminToken,
        accessToken,
        depositId: created.body.id as string,
        completion,
      };
    }

    /** First delivery of `body` fails in the ledger, leaving the event RECEIVED. */
    async function failFirstDelivery(body: string) {
      const spy = vi
        .spyOn(app.get(LedgerService), 'applyEntry')
        .mockRejectedValueOnce(new Error('injected transient failure'));
      try {
        await postWebhook(body).expect(500);
      } finally {
        spy.mockRestore();
      }
    }

    it('reports a stuck event once, never changes money, and stops reporting it after the redelivery recovers it', async () => {
      const eventId = `stale-dep-${runId}`;
      const { userId, adminToken, depositId, completion } =
        await depositWithCompletion('stalerecover', eventId);
      const body = completion();
      await failFirstDelivery(body);
      const storedPayload = (await eventRow(eventId))?.payload;
      await backdate(eventId, THIRTY_MINUTES_MS);

      const first = await runReconciliation(adminToken);
      const found = staleFor(first, depositId);
      expect(found).toHaveLength(1);
      expect(found[0].detail).toContain(eventId);
      expect(await openStaleRows(depositId)).toHaveLength(1);

      // Detection is read-only: no money, no status, no event change.
      expect(
        (await prisma.deposit.findUnique({ where: { id: depositId } }))?.status,
      ).toBe('PENDING');
      expect(
        (await prisma.wallet.findUnique({ where: { userId } }))
          ?.availableBalanceMinor,
      ).toBe(1000n);
      const stuck = await eventRow(eventId);
      expect(stuck?.status).toBe('RECEIVED');
      expect(stuck?.payload).toEqual(storedPayload);

      // A second run reports it again but records nothing new.
      const second = await runReconciliation(adminToken);
      expect(staleFor(second, depositId)).toHaveLength(1);
      expect(await openStaleRows(depositId)).toHaveLength(1);

      // The provider's retry recovers the event and credits exactly once.
      await postWebhook(body).expect(200);
      expect(
        (await prisma.deposit.findUnique({ where: { id: depositId } }))?.status,
      ).toBe('COMPLETED');
      expect(
        (await prisma.wallet.findUnique({ where: { userId } }))
          ?.availableBalanceMinor,
      ).toBe(6000n);
      expect((await eventRow(eventId))?.status).toBe('PROCESSED');

      // No longer reported, and nothing new recorded; the earlier anomaly is
      // left for an admin to resolve.
      const third = await runReconciliation(adminToken);
      expect(staleFor(third, depositId)).toHaveLength(0);
      expect(await openStaleRows(depositId)).toHaveLength(1);
    });

    it('does not report a recent RECEIVED event', async () => {
      const eventId = `stale-recent-${runId}`;
      const { adminToken, depositId, completion } = await depositWithCompletion(
        'stalerecent',
        eventId,
      );
      await failFirstDelivery(completion());
      await backdate(eventId, 60_000);

      const report = await runReconciliation(adminToken);

      expect(staleFor(report, depositId)).toHaveLength(0);
      expect(await openStaleRows(depositId)).toHaveLength(0);
    });

    it('raises a new anomaly after an admin resolved the old one while the event is still stale', async () => {
      const eventId = `stale-resolved-${runId}`;
      const { adminToken, depositId, completion } = await depositWithCompletion(
        'staleresolved',
        eventId,
      );
      await failFirstDelivery(completion());
      await backdate(eventId, THIRTY_MINUTES_MS);

      await runReconciliation(adminToken);
      const [open] = await openStaleRows(depositId);
      await request(app.getHttpServer())
        .post(
          `/api/v1/admin/payment-reconciliation/anomalies/${open.id}/resolve`,
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ resolutionNote: 'Reviewed; waiting for the provider to retry' })
        .expect(200);
      expect(await openStaleRows(depositId)).toHaveLength(0);

      await runReconciliation(adminToken);

      expect(await openStaleRows(depositId)).toHaveLength(1);
      expect(
        await prisma.paymentReconciliationAnomaly.count({
          where: { type: 'STALE_PROVIDER_EVENT', relatedDepositId: depositId },
        }),
      ).toBe(2);
    });

    it('keeps a conflicting redelivery visible without processing it or changing the stored payload', async () => {
      const eventId = `stale-conflict-${runId}`;
      const { userId, adminToken, depositId, completion } =
        await depositWithCompletion('staleconflict', eventId);
      await failFirstDelivery(completion());
      const storedPayload = (await eventRow(eventId))?.payload;

      // Same provider event id, different reported amount: acknowledged, never
      // acted on.
      await postWebhook(completion('999999')).expect(200);

      const after = await eventRow(eventId);
      expect(after?.status).toBe('RECEIVED');
      expect(after?.payload).toEqual(storedPayload);
      expect(
        (await prisma.deposit.findUnique({ where: { id: depositId } }))?.status,
      ).toBe('PENDING');

      await backdate(eventId, THIRTY_MINUTES_MS);
      const report = await runReconciliation(adminToken);

      expect(staleFor(report, depositId)).toHaveLength(1);
      expect(
        (await prisma.wallet.findUnique({ where: { userId } }))
          ?.availableBalanceMinor,
      ).toBe(1000n);
    });

    it('tracks stale events that match no record independently, once each', async () => {
      const { adminToken } = await setupFundedUser('staleorphan', '1000');
      const ids = [`stale-orphan-a-${runId}`, `stale-orphan-b-${runId}`];
      for (const id of ids) {
        await prisma.providerEvent.create({
          data: {
            provider: 'FAKE',
            providerEventId: id,
            eventType: 'deposit.completed',
            payload: {
              eventType: 'deposit.completed',
              providerReference: `no-such-deposit-${id}`,
            },
            status: 'RECEIVED',
            createdAt: new Date(Date.now() - THIRTY_MINUTES_MS),
          },
        });
      }
      const keys = ids.map((id) => `FAKE/${id}`);
      const mine = (r: Awaited<ReturnType<typeof runReconciliation>>) =>
        r.anomalies.filter(
          (a) =>
            a.type === 'STALE_PROVIDER_EVENT' &&
            a.eventKey !== undefined &&
            keys.includes(a.eventKey),
        );
      const openFor = () =>
        prisma.paymentReconciliationAnomaly.findMany({
          where: {
            type: 'STALE_PROVIDER_EVENT',
            status: 'OPEN',
            relatedDepositId: null,
            relatedWithdrawalId: null,
            details: {
              path: ['eventKey'],
              string_starts_with: `FAKE/stale-orphan-`,
            },
          },
        });

      try {
        const first = await runReconciliation(adminToken);
        expect(
          mine(first)
            .map((a) => a.eventKey)
            .sort(),
        ).toEqual(keys);
        const opened = (await openFor()).filter((a) =>
          keys.includes((a.details as { eventKey: string }).eventKey),
        );
        expect(opened).toHaveLength(2);

        // Repeat runs do not duplicate either one.
        await runReconciliation(adminToken);
        await runReconciliation(adminToken);
        expect(
          (await openFor()).filter((a) =>
            keys.includes((a.details as { eventKey: string }).eventKey),
          ),
        ).toHaveLength(2);
      } finally {
        await prisma.paymentReconciliationAnomaly.deleteMany({
          where: {
            type: 'STALE_PROVIDER_EVENT',
            details: {
              path: ['eventKey'],
              string_starts_with: `FAKE/stale-orphan-`,
            },
          },
        });
        await prisma.providerEvent.deleteMany({
          where: { providerEventId: { in: ids } },
        });
      }
    });

    it('rejects a non-admin from running reconciliation', async () => {
      const { accessToken } = await registerUser('stalenonadmin');

      await request(app.getHttpServer())
        .get('/api/v1/admin/payment-reconciliation/run')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
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
