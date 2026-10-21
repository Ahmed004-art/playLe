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
import { WalletService } from '../src/wallet/wallet.service.js';
import { LedgerService } from '../src/ledger/ledger.service.js';
import { FakePaymentProvider } from './fake-payment-provider.js';
import { waitForBackendBlockedBy } from './pg-locks.js';
import { vi } from 'vitest';

describe('Wallet / Deposits / Withdrawals (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let walletService: WalletService;
  let ledgerService: LedgerService;
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

    // `rawBody: true` is needed here too (not just in main.ts's
    // NestFactory.create) — createNestApplication builds its own HTTP
    // adapter and doesn't inherit it otherwise. Required for the webhook
    // signature-verification tests below, which need the exact raw bytes.
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
    walletService = moduleFixture.get(WalletService);
    ledgerService = moduleFixture.get(LedgerService);
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { contains: runId } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    await prisma.ledgerEntry.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.providerEvent.deleteMany({
      where: { deposit: { userId: { in: userIds } } },
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

  it('creates a zero-balance wallet automatically at registration', async () => {
    const { accessToken } = await registerUser('wallet1');

    const res = await request(app.getHttpServer())
      .get('/api/v1/wallet')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body).toMatchObject({
      availableBalanceMinor: '0',
      heldBalanceMinor: '0',
      totalBalanceMinor: '0',
      currency: 'SLE',
    });
  });

  describe('deposits', () => {
    it('rejects a deposit below the minimum', async () => {
      const { accessToken } = await registerUser('depmin');

      const res = await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '10' })
        .expect(422);

      expect(res.body.message).toMatch(/minimum deposit/i);
    });

    it('rejects a malformed (non-numeric) amount', async () => {
      const { accessToken } = await registerUser('depbad');

      await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '-500' })
        .expect(400);
    });

    it('requires an Idempotency-Key header', async () => {
      const { accessToken } = await registerUser('depnokey');

      await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amountMinor: '500' })
        .expect(400);
    });

    it('creates a PENDING deposit and returns the same deposit on retry with the same idempotency key', async () => {
      const { accessToken } = await registerUser('depok');
      const key = randomUUID();

      const first = await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', key)
        .send({ amountMinor: '5000' })
        .expect(201);

      expect(first.body.status).toBe('PENDING');

      const retry = await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', key)
        .send({ amountMinor: '5000' })
        .expect(201);

      expect(retry.body.id).toBe(first.body.id);

      const countAfter = await prisma.deposit.count({
        where: { id: first.body.id },
      });
      expect(countAfter).toBe(1);
    });

    it('credits the wallet only via a verified webhook event, never from client input', async () => {
      const { accessToken, userId } = await registerUser('depwebhook');

      const created = await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '7000' })
        .expect(201);

      const providerReference = created.body.providerReference as string;

      // The deposit stays PENDING until the webhook arrives — no client
      // call can mark it COMPLETED.
      const walletBefore = await request(app.getHttpServer())
        .get('/api/v1/wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(walletBefore.body.availableBalanceMinor).toBe('0');

      const body = fakeProvider.buildWebhookBody({
        eventType: 'deposit.completed',
        providerReference,
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
      expect(deposit?.status).toBe('COMPLETED');

      const walletAfter = await request(app.getHttpServer())
        .get('/api/v1/wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(walletAfter.body.availableBalanceMinor).toBe('7000');

      void userId;
    });

    it('rejects a webhook with an invalid signature and applies no ledger effect', async () => {
      const { accessToken } = await registerUser('depbadsig');

      const created = await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '5000' })
        .expect(201);

      const body = fakeProvider.buildWebhookBody({
        eventType: 'deposit.completed',
        providerReference: created.body.providerReference,
      });

      await request(app.getHttpServer())
        .post('/api/v1/payments/webhooks/monime')
        .set('x-fake-signature', 'wrong-secret')
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200); // handled, but internally rejected

      const deposit = await prisma.deposit.findUnique({
        where: { id: created.body.id },
      });
      expect(deposit?.status).toBe('PENDING');
    });

    it('is idempotent against a duplicate webhook delivery (same event id)', async () => {
      const { accessToken } = await registerUser('depdupwebhook');

      const created = await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '3000' })
        .expect(201);

      const providerReference = created.body.providerReference as string;
      const rawBody = fakeProvider.buildWebhookBody({
        eventType: 'deposit.completed',
        providerReference,
      });

      // Deliver the exact same body (same eventId inside it) twice.
      await request(app.getHttpServer())
        .post('/api/v1/payments/webhooks/monime')
        .set('x-fake-signature', fakeProvider.signatureHeader())
        .set('Content-Type', 'application/json')
        .send(rawBody)
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/payments/webhooks/monime')
        .set('x-fake-signature', fakeProvider.signatureHeader())
        .set('Content-Type', 'application/json')
        .send(rawBody)
        .expect(200);

      const wallet = await request(app.getHttpServer())
        .get('/api/v1/wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      // Credited exactly once, not twice.
      expect(wallet.body.availableBalanceMinor).toBe('3000');

      const ledgerCount = await prisma.ledgerEntry.count({
        where: { relatedDepositId: created.body.id, type: 'DEPOSIT' },
      });
      expect(ledgerCount).toBe(1);
    });

    // Two *different* provider events confirming one deposit are not caught by
    // the ProviderEvent (provider, providerEventId) uniqueness the test above
    // relies on, so exactly-once crediting has to come from
    // `completeFromProviderEvent` itself. It reads the deposit and checks
    // PENDING outside its transaction, and neither the ledger credit nor the
    // COMPLETED update re-checks. This forces the interleaving without timing:
    // both completions are held at the first statement of their transaction
    // (past the PENDING check) until both have arrived, then released together.
    it('credits a deposit exactly once when two different events confirm it concurrently', async () => {
      const { accessToken, userId } = await registerUser('depraceevt');

      const created = await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '4000' })
        .expect(201);
      const depositId = created.body.id as string;
      const providerReference = created.body.providerReference as string;

      const realGetWalletId =
        walletService.getWalletIdForUser.bind(walletService);
      let arrived = 0;
      let release!: () => void;
      const bothArrived = new Promise<void>((resolve) => (release = resolve));
      // Safety valve only: with the current code both completions always
      // arrive within milliseconds. It exists so a future fix that serializes
      // the two *before* this point cannot leave the test hanging.
      const valve = setTimeout(release, 5000);
      vi.spyOn(walletService, 'getWalletIdForUser').mockImplementation(
        async (client, id) => {
          if (id === userId && client !== prisma) {
            arrived += 1;
            if (arrived === 2) release();
            await bothArrived;
          }
          return realGetWalletId(client, id);
        },
      );

      const deliver = () =>
        request(app.getHttpServer())
          .post('/api/v1/payments/webhooks/monime')
          .set('x-fake-signature', fakeProvider.signatureHeader())
          .set('Content-Type', 'application/json')
          .send(
            // A fresh eventId per call: two distinct provider events.
            fakeProvider.buildWebhookBody({
              eventType: 'deposit.completed',
              providerReference,
            }),
          )
          .then((res) => res);

      let responses: { status: number; body: unknown }[];
      try {
        responses = await Promise.all([deliver(), deliver()]);
      } finally {
        clearTimeout(valve);
        release();
        vi.restoreAllMocks();
      }

      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      // Both completions really overlapped past the PENDING check.
      expect(arrived).toBe(2);

      // Two distinct events were recorded and processed - the same-event
      // dedupe did not apply here.
      const events = await prisma.providerEvent.findMany({
        where: { relatedDepositId: depositId },
      });
      expect(events).toHaveLength(2);
      expect(new Set(events.map((e) => e.providerEventId)).size).toBe(2);

      // Credited exactly once.
      const deposit = await prisma.deposit.findUniqueOrThrow({
        where: { id: depositId },
      });
      expect(deposit.status).toBe('COMPLETED');
      const wallet = await request(app.getHttpServer())
        .get('/api/v1/wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(wallet.body.availableBalanceMinor).toBe('4000');
      expect(
        await prisma.ledgerEntry.count({
          where: { relatedDepositId: depositId, type: 'DEPOSIT' },
        }),
      ).toBe(1);
    }, 20000);

    describe('a completion racing a failure or expiry event', () => {
      // `markFailed` / `markExpired` read PENDING outside any transaction and
      // then write FAILED / EXPIRED with an update that has no status
      // predicate. A completion that commits between their read and their
      // write is therefore overwritten: wallet credited, deposit "failed".
      //
      // The interleaving is forced through the database, not timing: the
      // completion is held open *after* its real ledger credit (row lock on
      // the deposit held, wallet credit uncommitted); the competing event then
      // reads PENDING (the completion is invisible to it) and its write blocks
      // on that row lock. Postgres is asked, via pg_blocking_pids, to confirm
      // the dependency before the completion is allowed to commit.
      afterEach(() => {
        vi.restoreAllMocks();
      });

      async function raceCompletionAgainst(
        label: string,
        losing: { eventType: 'deposit.failed' | 'deposit.expired' },
      ) {
        const { accessToken, userId } = await registerUser(label);
        const created = await request(app.getHttpServer())
          .post('/api/v1/deposits')
          .set('Authorization', `Bearer ${accessToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({ amountMinor: '4000' })
          .expect(201);
        const depositId = created.body.id as string;
        const providerReference = created.body.providerReference as string;

        const realApplyEntry = ledgerService.applyEntry.bind(ledgerService);
        let reachedGate!: () => void;
        const reached = new Promise<void>((resolve) => (reachedGate = resolve));
        let openGate!: () => void;
        const gate = new Promise<void>((resolve) => (openGate = resolve));
        let completionPid: number | undefined;
        let paused = false;
        vi.spyOn(ledgerService, 'applyEntry').mockImplementation(
          async (tx, walletId, params) => {
            const result = await realApplyEntry(tx, walletId, params);
            if (
              params.type === 'DEPOSIT' &&
              params.relatedDepositId === depositId &&
              !paused
            ) {
              paused = true;
              const [{ pid }] = await tx.$queryRaw<
                { pid: number }[]
              >`SELECT pg_backend_pid() AS pid`;
              completionPid = pid;
              reachedGate();
              await gate;
            }
            return result;
          },
        );

        const deliver = (
          eventType: 'deposit.completed' | 'deposit.failed' | 'deposit.expired',
        ) =>
          request(app.getHttpServer())
            .post('/api/v1/payments/webhooks/monime')
            .set('x-fake-signature', fakeProvider.signatureHeader())
            .set('Content-Type', 'application/json')
            .send(
              // A fresh eventId per call: distinct provider events.
              fakeProvider.buildWebhookBody({
                eventType,
                providerReference,
                reason:
                  eventType === 'deposit.failed'
                    ? 'provider reported a failed deposit'
                    : undefined,
              }),
            )
            .then((res) => res);

        const completion = deliver('deposit.completed');
        let competing: ReturnType<typeof deliver> | undefined;
        let responses: { status: number }[];
        try {
          await reached;
          if (completionPid === undefined) {
            throw new Error('completion backend pid not captured');
          }

          competing = deliver(losing.eventType);
          // The competing event has read PENDING and is now waiting on the
          // deposit row the open completion holds.
          const blocked = await waitForBackendBlockedBy(prisma, completionPid);
          expect(blocked.every((b) => b.wait_event_type === 'Lock')).toBe(true);
          expect(
            blocked.some((b) => /UPDATE "public"\."deposits"/.test(b.query)),
          ).toBe(true);

          openGate();
          responses = await Promise.all([completion, competing]);
        } finally {
          openGate();
          await Promise.allSettled([completion, competing ?? completion]);
        }

        expect(responses.map((r) => r.status)).toEqual([200, 200]);
        return { accessToken, userId, depositId };
      }

      async function expectCreditedAndCompleted(
        accessToken: string,
        depositId: string,
      ): Promise<void> {
        // Both distinct events were recorded and processed.
        const events = await prisma.providerEvent.findMany({
          where: { relatedDepositId: depositId },
        });
        expect(events).toHaveLength(2);
        expect(new Set(events.map((e) => e.providerEventId)).size).toBe(2);
        expect(events.every((e) => e.status === 'PROCESSED')).toBe(true);

        // The completion's outcome survived.
        const deposit = await prisma.deposit.findUniqueOrThrow({
          where: { id: depositId },
        });
        expect(deposit.status).toBe('COMPLETED');
        expect(deposit.failedAt).toBeNull();
        expect(deposit.failureReason).toBeNull();
        expect(deposit.completedAt).not.toBeNull();

        const wallet = await request(app.getHttpServer())
          .get('/api/v1/wallet')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);
        expect(wallet.body.availableBalanceMinor).toBe('4000');
        expect(
          await prisma.ledgerEntry.count({
            where: { relatedDepositId: depositId, type: 'DEPOSIT' },
          }),
        ).toBe(1);
      }

      it('deposit.completed racing deposit.failed leaves the deposit COMPLETED and sends no failure notice', async () => {
        const { accessToken, userId, depositId } = await raceCompletionAgainst(
          'depracefail',
          { eventType: 'deposit.failed' },
        );

        await expectCreditedAndCompleted(accessToken, depositId);

        // The completion notification is intact and the losing failure
        // transition queued nothing.
        const outbox = await prisma.notificationOutbox.findMany({
          where: { userId },
        });
        expect(outbox.map((n) => n.type)).toEqual(['DEPOSIT_COMPLETED']);
      }, 20000);

      it('deposit.completed racing deposit.expired leaves the deposit COMPLETED', async () => {
        const { accessToken, userId, depositId } = await raceCompletionAgainst(
          'depraceexp',
          { eventType: 'deposit.expired' },
        );

        await expectCreditedAndCompleted(accessToken, depositId);

        const outbox = await prisma.notificationOutbox.findMany({
          where: { userId },
        });
        expect(outbox.map((n) => n.type)).toEqual(['DEPOSIT_COMPLETED']);
      }, 20000);
    });

    describe('a completion that reports an amount or currency', () => {
      // The credit is always the deposit's own stored amount, so a verified
      // `deposit.completed` event whose reported amount/currency disagree with
      // that deposit must not credit it, claim it, or announce it. `amountMinor`
      // is a canonical decimal-integer string of minor units; `currency` a
      // 3-letter ISO code; both present or both absent. A provider that reports
      // neither (every pre-existing test above) keeps its legacy behaviour.
      async function openDeposit(label: string) {
        const { accessToken, userId } = await registerUser(label);
        const created = await request(app.getHttpServer())
          .post('/api/v1/deposits')
          .set('Authorization', `Bearer ${accessToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({ amountMinor: '4000' })
          .expect(201);
        return {
          accessToken,
          userId,
          depositId: created.body.id as string,
          providerReference: created.body.providerReference as string,
        };
      }

      async function deliverCompleted(
        providerReference: string,
        reported: { amountMinor?: unknown; currency?: unknown },
        /** Pass the same id again to replay a delivery verbatim. */
        eventId: string = randomUUID(),
      ) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/payments/webhooks/monime')
          .set('x-fake-signature', fakeProvider.signatureHeader())
          .set('Content-Type', 'application/json')
          .send(
            fakeProvider.buildWebhookBody({
              eventId,
              eventType: 'deposit.completed',
              providerReference,
              ...reported,
            }),
          );
        return { res, eventId };
      }

      /** Nothing happened to the deposit, the wallet or the outbox. */
      async function expectUntouched(
        accessToken: string,
        userId: string,
        depositId: string,
      ): Promise<void> {
        const deposit = await prisma.deposit.findUniqueOrThrow({
          where: { id: depositId },
        });
        expect(deposit.status).toBe('PENDING');
        expect(deposit.completedAt).toBeNull();
        expect(deposit.failedAt).toBeNull();
        const wallet = await request(app.getHttpServer())
          .get('/api/v1/wallet')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);
        expect(wallet.body.availableBalanceMinor).toBe('0');
        expect(
          await prisma.ledgerEntry.count({
            where: { relatedDepositId: depositId },
          }),
        ).toBe(0);
        expect(
          await prisma.notificationOutbox.count({ where: { userId } }),
        ).toBe(0);
      }

      const rejected: [
        string,
        { amountMinor?: unknown; currency?: unknown },
      ][] = [
        ['amount below the deposit', { amountMinor: '1', currency: 'SLE' }],
        [
          'amount above the deposit',
          { amountMinor: '400000', currency: 'SLE' },
        ],
        ['currency mismatch', { amountMinor: '4000', currency: 'USD' }],
        ['fractional amount', { amountMinor: '40.5', currency: 'SLE' }],
        ['negative amount', { amountMinor: '-4000', currency: 'SLE' }],
        ['amount as a JSON number', { amountMinor: 4000, currency: 'SLE' }],
        ['amount without currency', { amountMinor: '4000' }],
        ['currency without amount', { currency: 'SLE' }],
      ];

      it.each(rejected)(
        'rejects %s: deposit stays PENDING, no credit, no notification',
        async (name, reported) => {
          // A distinct identity per case: email and username derive from the
          // label, so reusing one across the table is a 409 on registration.
          // Deterministic: the case's position in the table.
          const { accessToken, userId, depositId, providerReference } =
            await openDeposit(
              `depamt${rejected.findIndex(([caseName]) => caseName === name)}`,
            );

          const { res, eventId } = await deliverCompleted(
            providerReference,
            reported,
          );

          expect(res.status).toBe(200);
          expect(res.body.status).toBe('rejected');
          await expectUntouched(accessToken, userId, depositId);

          // Kept for audit, never as processed.
          const events = await prisma.providerEvent.findMany({
            where: { providerEventId: eventId },
          });
          expect(events).toHaveLength(1);
          expect(events[0].status).toBe('REJECTED');
          expect(events[0].relatedDepositId).toBe(depositId);
        },
        20000,
      );

      it('completes the deposit exactly once when amount and currency match', async () => {
        const { accessToken, userId, depositId, providerReference } =
          await openDeposit('depamtok');

        const first = await deliverCompleted(providerReference, {
          amountMinor: '4000',
          currency: 'SLE',
        });
        // A second, distinct event with the same matching values (provider
        // retry under a new id) must not credit again.
        const second = await deliverCompleted(providerReference, {
          amountMinor: '4000',
          currency: 'SLE',
        });

        expect(first.res.body.status).toBe('processed');
        expect(second.res.status).toBe(200);
        const deposit = await prisma.deposit.findUniqueOrThrow({
          where: { id: depositId },
        });
        expect(deposit.status).toBe('COMPLETED');
        const wallet = await request(app.getHttpServer())
          .get('/api/v1/wallet')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);
        expect(wallet.body.availableBalanceMinor).toBe('4000');
        expect(
          await prisma.ledgerEntry.count({
            where: { relatedDepositId: depositId, type: 'DEPOSIT' },
          }),
        ).toBe(1);
        expect(
          (await prisma.notificationOutbox.findMany({ where: { userId } })).map(
            (n) => n.type,
          ),
        ).toEqual(['DEPOSIT_COMPLETED']);
      }, 20000);

      it('replaying a rejected event id is ignored: one event row, the deposit stays PENDING and untouched', async () => {
        const { accessToken, userId, depositId, providerReference } =
          await openDeposit('depamtreplay');
        const eventId = randomUUID();
        const reported = { amountMinor: '1', currency: 'SLE' };

        const first = await deliverCompleted(
          providerReference,
          reported,
          eventId,
        );
        const replay = await deliverCompleted(
          providerReference,
          reported,
          eventId,
        );

        expect(first.res.body.status).toBe('rejected');
        expect(replay.res.status).toBe(200);
        expect(replay.res.body.status).toBe('ignored');
        const events = await prisma.providerEvent.findMany({
          where: { providerEventId: eventId },
        });
        expect(events).toHaveLength(1);
        expect(events[0].status).toBe('REJECTED');
        await expectUntouched(accessToken, userId, depositId);
      }, 20000);

      it('replaying a matching event id credits exactly once and never re-announces', async () => {
        const { accessToken, userId, depositId, providerReference } =
          await openDeposit('depamtreplok');
        const eventId = randomUUID();
        const reported = { amountMinor: '4000', currency: 'SLE' };

        const first = await deliverCompleted(
          providerReference,
          reported,
          eventId,
        );
        const replay = await deliverCompleted(
          providerReference,
          reported,
          eventId,
        );
        const again = await deliverCompleted(
          providerReference,
          reported,
          eventId,
        );

        expect(first.res.body.status).toBe('processed');
        expect(replay.res.body.status).toBe('ignored');
        expect(again.res.body.status).toBe('ignored');
        expect(
          await prisma.providerEvent.count({
            where: { providerEventId: eventId },
          }),
        ).toBe(1);
        const wallet = await request(app.getHttpServer())
          .get('/api/v1/wallet')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);
        expect(wallet.body.availableBalanceMinor).toBe('4000');
        expect(
          await prisma.ledgerEntry.count({
            where: { relatedDepositId: depositId, type: 'DEPOSIT' },
          }),
        ).toBe(1);
        expect(
          (await prisma.notificationOutbox.findMany({ where: { userId } })).map(
            (n) => n.type,
          ),
        ).toEqual(['DEPOSIT_COMPLETED']);
      }, 20000);

      it('a rejected mismatching event does not consume the deposit: a later matching event completes it', async () => {
        const { accessToken, userId, depositId, providerReference } =
          await openDeposit('depamtlate');

        const bad = await deliverCompleted(providerReference, {
          amountMinor: '1',
          currency: 'SLE',
        });
        expect(bad.res.body.status).toBe('rejected');
        await expectUntouched(accessToken, userId, depositId);

        const good = await deliverCompleted(providerReference, {
          amountMinor: '4000',
          currency: 'SLE',
        });
        expect(good.res.body.status).toBe('processed');

        const deposit = await prisma.deposit.findUniqueOrThrow({
          where: { id: depositId },
        });
        expect(deposit.status).toBe('COMPLETED');
        const wallet = await request(app.getHttpServer())
          .get('/api/v1/wallet')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);
        expect(wallet.body.availableBalanceMinor).toBe('4000');
        expect(
          await prisma.ledgerEntry.count({
            where: { relatedDepositId: depositId, type: 'DEPOSIT' },
          }),
        ).toBe(1);
      }, 20000);
    });

    it('marks a deposit FAILED on a verified deposit.failed event, with no ledger effect', async () => {
      const { accessToken } = await registerUser('depfailed');

      const created = await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '4000' })
        .expect(201);

      const body = fakeProvider.buildWebhookBody({
        eventType: 'deposit.failed',
        providerReference: created.body.providerReference,
        reason: 'Provider reported insufficient funds',
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
      expect(deposit?.status).toBe('FAILED');
      expect(deposit?.failureReason).toMatch(/insufficient funds/i);

      const wallet = await request(app.getHttpServer())
        .get('/api/v1/wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(wallet.body.availableBalanceMinor).toBe('0');

      const ledgerCount = await prisma.ledgerEntry.count({
        where: { relatedDepositId: created.body.id },
      });
      expect(ledgerCount).toBe(0);
    });

    it('safely ignores a webhook referencing an unknown provider reference', async () => {
      const body = fakeProvider.buildWebhookBody({
        eventType: 'deposit.completed',
        providerReference: 'fake_does-not-exist',
      });

      await request(app.getHttpServer())
        .post('/api/v1/payments/webhooks/monime')
        .set('x-fake-signature', fakeProvider.signatureHeader())
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);
    });
  });

  describe('withdrawals', () => {
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

    it('rejects a withdrawal below the minimum', async () => {
      const { accessToken } = await setupFundedUser('wdmin', '10000');

      await request(app.getHttpServer())
        .post('/api/v1/withdrawals')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          amountMinor: '10',
          destinationDetails: { method: 'ORANGE_MONEY' },
        })
        .expect(422);
    });

    it('rejects a withdrawal exceeding available balance', async () => {
      const { accessToken } = await setupFundedUser('wdinsuff', '1000');

      await request(app.getHttpServer())
        .post('/api/v1/withdrawals')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          amountMinor: '999999',
          destinationDetails: { method: 'ORANGE_MONEY' },
        })
        .expect(422);
    });

    it('holds funds atomically on creation and is idempotent on retry', async () => {
      const { accessToken, userId } = await setupFundedUser('wdhold', '10000');
      const key = randomUUID();
      const body = {
        amountMinor: '4000',
        destinationDetails: {
          method: 'ORANGE_MONEY',
          phoneNumber: '+23276000000',
        },
      };

      const first = await request(app.getHttpServer())
        .post('/api/v1/withdrawals')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      expect(first.body.status).toBe('PENDING_REVIEW');

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      expect(wallet?.availableBalanceMinor).toBe(6000n);
      expect(wallet?.heldBalanceMinor).toBe(4000n);

      const retry = await request(app.getHttpServer())
        .post('/api/v1/withdrawals')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      expect(retry.body.id).toBe(first.body.id);

      const walletAfterRetry = await prisma.wallet.findUnique({
        where: { userId },
      });
      // A retried create must not create a second hold.
      expect(walletAfterRetry?.heldBalanceMinor).toBe(4000n);
    });

    it('lets a user cancel their own PENDING_REVIEW withdrawal and releases the hold', async () => {
      const { accessToken, userId } = await setupFundedUser(
        'wdcancel',
        '10000',
      );

      const created = await request(app.getHttpServer())
        .post('/api/v1/withdrawals')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          amountMinor: '2000',
          destinationDetails: { method: 'ORANGE_MONEY' },
        })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/withdrawals/${created.body.id}/cancel`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      expect(wallet?.availableBalanceMinor).toBe(10000n);
      expect(wallet?.heldBalanceMinor).toBe(0n);
    });

    it('admin fail (an approved payout attempt that did not go through) releases the hold', async () => {
      const { accessToken, userId, adminToken } = await setupFundedUser(
        'wdfail',
        '10000',
      );

      const created = await request(app.getHttpServer())
        .post('/api/v1/withdrawals')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          amountMinor: '4000',
          destinationDetails: { method: 'ORANGE_MONEY' },
        })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${created.body.id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Verified identity via support ticket #100' })
        .expect(200);

      const failed = await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${created.body.id}/fail`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Mobile money payout attempt did not go through' })
        .expect(200);

      expect(failed.body.status).toBe('FAILED');
      expect(failed.body.failureReason).toMatch(/did not go through/i);

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      expect(wallet?.availableBalanceMinor).toBe(10000n);
      expect(wallet?.heldBalanceMinor).toBe(0n);
    });

    it('full admin lifecycle: approve then complete removes held funds permanently', async () => {
      const { accessToken, userId, adminToken } = await setupFundedUser(
        'wdcomplete',
        '10000',
      );

      const created = await request(app.getHttpServer())
        .post('/api/v1/withdrawals')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          amountMinor: '4000',
          destinationDetails: { method: 'ORANGE_MONEY' },
        })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${created.body.id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Verified identity via support ticket #99' })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${created.body.id}/complete`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Payout sent manually' })
        .expect(200);

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      expect(wallet?.availableBalanceMinor).toBe(6000n);
      expect(wallet?.heldBalanceMinor).toBe(0n);
    });

    it('admin reject releases the hold', async () => {
      const { accessToken, userId, adminToken } = await setupFundedUser(
        'wdreject',
        '10000',
      );

      const created = await request(app.getHttpServer())
        .post('/api/v1/withdrawals')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          amountMinor: '4000',
          destinationDetails: { method: 'ORANGE_MONEY' },
        })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${created.body.id}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Could not verify destination account ownership' })
        .expect(200);

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      expect(wallet?.availableBalanceMinor).toBe(10000n);
      expect(wallet?.heldBalanceMinor).toBe(0n);
    });

    it('rejects a non-admin attempting to approve a withdrawal', async () => {
      const { accessToken } = await setupFundedUser('wdunauth', '10000');

      const created = await request(app.getHttpServer())
        .post('/api/v1/withdrawals')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          amountMinor: '2000',
          destinationDetails: { method: 'ORANGE_MONEY' },
        })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${created.body.id}/approve`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ reason: 'Attempting self-approval without admin rights' })
        .expect(403);
    });

    it('rejects an invalid state transition (approving a non-pending withdrawal)', async () => {
      const { accessToken, adminToken } = await setupFundedUser(
        'wdbadtransition',
        '10000',
      );

      const created = await request(app.getHttpServer())
        .post('/api/v1/withdrawals')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          amountMinor: '2000',
          destinationDetails: { method: 'ORANGE_MONEY' },
        })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${created.body.id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'First approval' })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/withdrawals/${created.body.id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Second approval attempt on already-approved item' })
        .expect(409);
    });

    it('prevents cross-user access to another user’s withdrawal (IDOR)', async () => {
      const { accessToken } = await setupFundedUser('wdowner', '10000');
      const other = await registerUser('wdintruder');

      const created = await request(app.getHttpServer())
        .post('/api/v1/withdrawals')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          amountMinor: '2000',
          destinationDetails: { method: 'ORANGE_MONEY' },
        })
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/withdrawals/${created.body.id}`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(404);

      await request(app.getHttpServer())
        .post(`/api/v1/withdrawals/${created.body.id}/cancel`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(404);
    });

    it('allows only one of two concurrent withdrawals that together exceed the balance', async () => {
      const { accessToken, userId } = await setupFundedUser(
        'wdconcurrent',
        '10000',
      );

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/withdrawals')
          .set('Authorization', `Bearer ${accessToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            amountMinor: '6000',
            destinationDetails: { method: 'ORANGE_MONEY' },
          }),
        request(app.getHttpServer())
          .post('/api/v1/withdrawals')
          .set('Authorization', `Bearer ${accessToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            amountMinor: '6000',
            destinationDetails: { method: 'ORANGE_MONEY' },
          }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      // Exactly one succeeds (201); the other must fail with 422
      // (insufficient balance) — the row lock in LedgerService.applyEntry
      // serializes the two concurrent requests against the real database.
      expect(statuses).toEqual([201, 422]);

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      expect(wallet?.availableBalanceMinor).toBe(4000n);
      expect(wallet?.heldBalanceMinor).toBe(6000n);
    });
  });

  describe('admin financial visibility', () => {
    it('lets an admin view any user’s wallet, ledger, deposits, and withdrawals', async () => {
      const { accessToken, userId } = await registerUser('visible');
      const admin = await registerUser('visibleadmin');
      await makeAdmin(admin.userId);
      await creditViaAdmin(admin.accessToken, userId, '2000');

      await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '5000' })
        .expect(201);

      const walletRes = await request(app.getHttpServer())
        .get(`/api/v1/admin/wallets/${userId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(walletRes.body.availableBalanceMinor).toBe('2000');

      const ledgerRes = await request(app.getHttpServer())
        .get(`/api/v1/admin/ledger?userId=${userId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(ledgerRes.body.items.length).toBeGreaterThan(0);

      const depositsRes = await request(app.getHttpServer())
        .get(`/api/v1/admin/deposits?userId=${userId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(depositsRes.body.items.length).toBe(1);
    });

    it('rejects a non-admin from the admin finance routes', async () => {
      const { accessToken, userId } = await registerUser('notadmin');

      await request(app.getHttpServer())
        .get(`/api/v1/admin/wallets/${userId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });

    it('requires a reason of at least 10 characters for an adjustment', async () => {
      const { userId } = await registerUser('shortreason');
      const admin = await registerUser('shortreasonadmin');
      await makeAdmin(admin.userId);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/wallets/${userId}/adjustments`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ direction: 'CREDIT', amountMinor: '100', reason: 'short' })
        .expect(400);
    });

    it('rejects a DEBIT adjustment that would drive the balance negative', async () => {
      const { userId } = await registerUser('debitoverdraw');
      const admin = await registerUser('debitoverdrawadmin');
      await makeAdmin(admin.userId);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/wallets/${userId}/adjustments`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          direction: 'DEBIT',
          amountMinor: '100',
          reason: 'Attempting to overdraw a zero balance wallet',
        })
        .expect(422);
    });
  });

  describe('account status enforcement on financial routes', () => {
    it('rejects a suspended user from accessing their wallet', async () => {
      const { accessToken, userId } = await registerUser('suspendedwallet');
      await prisma.user.update({
        where: { id: userId },
        data: { status: 'SUSPENDED' },
      });

      await request(app.getHttpServer())
        .get('/api/v1/wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);
    });

    it('rejects a disabled user from creating a deposit, even with a previously-issued token', async () => {
      const { accessToken, userId } = await registerUser('disabledwallet');
      await prisma.user.update({
        where: { id: userId },
        data: { status: 'DISABLED' },
      });

      await request(app.getHttpServer())
        .post('/api/v1/deposits')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ amountMinor: '5000' })
        .expect(401);
    });
  });
});
