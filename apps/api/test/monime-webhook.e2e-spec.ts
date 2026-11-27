import { createHmac, randomUUID } from 'node:crypto';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { AppConfiguration } from '../src/config/configuration.js';
import { PAYMENT_PROVIDER } from '../src/payments/ports/payment-provider.port.js';
import { MonimeProvider } from '../src/payments/providers/monime.provider.js';
import { PaymentReconciliationService } from '../src/payments/payment-reconciliation.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * The real `MonimeProvider` behind the real webhook endpoint, against Postgres:
 * signed deliveries in Monime's documented scheme (`Monime-Signature:
 * t=<unix>,v1=<base64 HMAC-SHA256 of "<t>_<raw body>">`). Only Monime's HTTP
 * API is stubbed (payment-code creation); no request leaves the process. This
 * proves PlayLe's side of the contract; a real Monime Test delivery is still
 * needed to confirm Monime's side (see MONIME_SETUP.md).
 */
describe('Monime webhooks, signed (e2e)', () => {
  const SECRET = `whsec_e2e_${randomUUID()}`;
  const BASE = 'https://monime.invalid';
  let app: INestApplication;
  let prisma: PrismaService;
  const runId = randomUUID().slice(0, 8);
  const eventIds: string[] = [];

  beforeAll(async () => {
    const payments = {
      provider: 'monime',
      monimeApiKey: 'mon_test_e2e',
      monimeSpaceId: 'spc-e2e',
      monimeWebhookSecret: SECRET,
      monimeBaseUrl: BASE,
      monimeHttpTimeoutMs: 5000,
      monimeLivePaymentsEnabled: false,
    };
    const config = {
      get: (key: string) => (key === 'payments' ? payments : undefined),
    } as unknown as ConfigService<AppConfiguration, true>;

    let codes = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url === `${BASE}/v1/payment-codes` && init?.method === 'POST') {
        codes += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              result: {
                id: `pmc-${runId}-${codes}`,
                ussdCode: '*715*1*0000#',
                expireTime: new Date(Date.now() + 600_000).toISOString(),
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(new MonimeProvider(config))
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

  afterAll(async () => {
    vi.restoreAllMocks();
    const users = await prisma.user.findMany({
      where: { email: { contains: runId } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    await prisma.providerOperation.deleteMany({
      where: { deposit: { userId: { in: userIds } } },
    });
    await prisma.ledgerEntry.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.providerEvent.deleteMany({
      where: { providerEventId: { in: eventIds } },
    });
    await prisma.paymentReconciliationAnomaly.deleteMany({
      where: { details: { path: ['detail'], string_contains: runId } },
    });
    await prisma.deposit.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  async function pendingDeposit(label: string, amountMinor = '5000') {
    const registered = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: `${label}-${runId}@example.com`,
        username: `${label}${runId}`.slice(0, 20),
        password: 'Passw0rd1',
        dateOfBirth: '2000-01-01',
      })
      .expect(201);
    const created = await request(app.getHttpServer())
      .post('/api/v1/deposits')
      .set('Authorization', `Bearer ${registered.body.accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor })
      .expect(201);
    const deposit = await prisma.deposit.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(deposit.providerReference).toMatch(/^pmc-/);
    return { userId: registered.body.user.id as string, deposit };
  }

  function completion(paymentCode: string, value: number, eventId?: string) {
    const id = eventId ?? `wke-${randomUUID()}`;
    eventIds.push(id);
    return JSON.stringify({
      apiVersion: 'caph.2025-08-23',
      event: {
        id,
        name: 'payment_code.completed',
        timestamp: `${Math.floor(Date.now() / 1000)}`,
      },
      object: { id: paymentCode, type: 'payment_code' },
      data: {
        id: paymentCode,
        mode: 'one_time',
        status: 'completed',
        amount: { currency: 'SLE', value },
        processedPaymentData: { amount: { currency: 'SLE', value } },
      },
    });
  }

  const signature = (
    body: string,
    t = Math.floor(Date.now() / 1000),
    secret = SECRET,
  ) =>
    `t=${t},v1=${createHmac('sha256', secret).update(`${t}_${body}`).digest('base64')}`;

  const deliver = (body: string, monimeSignature = signature(body)) =>
    request(app.getHttpServer())
      .post('/api/v1/payments/webhooks/monime')
      .set('Content-Type', 'application/json')
      .set('Monime-Signature', monimeSignature)
      .send(body);

  const balance = async (userId: string) => {
    const w = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    return { available: w.availableBalanceMinor, held: w.heldBalanceMinor };
  };
  const credits = (depositId: string) =>
    prisma.ledgerEntry.count({
      where: { relatedDepositId: depositId, type: 'DEPOSIT' },
    });
  const statusOf = async (depositId: string) =>
    (await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } }))
      .status;

  it('credits a signed completion exactly once, however often it or another event repeats it', async () => {
    const { userId, deposit } = await pendingDeposit('mwhok');
    const body = completion(deposit.providerReference!, 5000);

    const first = await deliver(body).expect(200);
    expect(first.body.status).toBe('processed');
    // The same signed delivery replayed, and a second event for the same code.
    await deliver(body).expect(200);
    await deliver(completion(deposit.providerReference!, 5000)).expect(200);

    expect(await statusOf(deposit.id)).toBe('COMPLETED');
    expect(await credits(deposit.id)).toBe(1);
    expect(await balance(userId)).toEqual({ available: 5000n, held: 0n });
  });

  it.each([
    ['a wrong secret', (b: string) => signature(b, undefined, 'z'.repeat(40))],
    [
      'a timestamp older than five minutes',
      (b: string) => signature(b, Math.floor(Date.now() / 1000) - 301),
    ],
    [
      'a timestamp more than a minute ahead',
      (b: string) => signature(b, Math.floor(Date.now() / 1000) + 61),
    ],
    ['no v1 signature', () => `t=${Math.floor(Date.now() / 1000)}`],
  ])(
    'rejects (401) and stores nothing for %s',
    async (_name, makeSignature) => {
      const { userId, deposit } = await pendingDeposit(
        `mwhbad${randomUUID().slice(0, 4)}`,
      );
      const body = completion(deposit.providerReference!, 5000);
      const eventId = (JSON.parse(body) as { event: { id: string } }).event.id;

      await deliver(body, makeSignature(body)).expect(401);

      expect(
        await prisma.providerEvent.count({
          where: { providerEventId: eventId },
        }),
      ).toBe(0);
      expect(await statusOf(deposit.id)).toBe('PENDING');
      expect(await balance(userId)).toEqual({ available: 0n, held: 0n });
    },
  );

  it('rejects a body altered after signing', async () => {
    const { deposit } = await pendingDeposit('mwhtamper');
    const body = completion(deposit.providerReference!, 5000);
    const sig = signature(body);

    await deliver(body.replace('"value":5000', '"value":50000'), sig).expect(
      401,
    );
    expect(await statusOf(deposit.id)).toBe('PENDING');
  });

  it('rejects (401) a correctly signed body that is not a Monime event', async () => {
    await deliver('{"not":"an event"}').expect(401);
  });

  it('refuses to credit a signed completion for a different amount', async () => {
    const { userId, deposit } = await pendingDeposit('mwhamount');
    const body = completion(deposit.providerReference!, 4000);

    const res = await deliver(body).expect(200);

    expect(res.body.status).toBe('rejected');
    expect(await statusOf(deposit.id)).toBe('PENDING');
    expect(await credits(deposit.id)).toBe(0);
    expect(await balance(userId)).toEqual({ available: 0n, held: 0n });
  });

  it('keeps a signed completion without a paid amount as delivered, credits nothing, and reports it', async () => {
    const { userId, deposit } = await pendingDeposit('mwhnopaid');
    const id = `wke-${randomUUID()}`;
    eventIds.push(id);
    // Monime's documented caph payment_code.completed sample, verbatim shape.
    const body = JSON.stringify({
      apiVersion: 'caph.2025-08-23',
      event: {
        id,
        name: 'payment_code.completed',
        timestamp: `${Math.floor(Date.now() / 1000)}`,
      },
      object: { id: deposit.providerReference, type: 'payment_code' },
      data: {
        id: deposit.providerReference,
        mode: 'one_time',
        status: 'completed',
        amount: { currency: 'SLE', value: 5000 },
        enable: true,
        updateTime: new Date().toISOString(),
      },
    });

    const res = await deliver(body).expect(200);

    expect(res.body.status).toBe('ignored');
    expect(await statusOf(deposit.id)).toBe('PENDING');
    expect(await balance(userId)).toEqual({ available: 0n, held: 0n });
    const stored = await prisma.providerEvent.findFirstOrThrow({
      where: { providerEventId: id },
    });
    expect(stored.status).toBe('IGNORED');
    expect(stored.payload).toEqual({ unmappedMonimeEvent: JSON.parse(body) });
    const report = await app.get(PaymentReconciliationService).runOnce();
    expect(
      report.anomalies.some(
        (a) => a.type === 'ORPHAN_PROVIDER_EVENT' && a.detail.includes(id),
      ),
    ).toBe(true);
  });
});
