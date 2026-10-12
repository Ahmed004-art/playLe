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
import { FakeDeliveryAdapter } from '../src/notifications/fake-delivery.adapter.js';
import { NotificationDispatcherService } from '../src/notification-outbox/notification-dispatcher.service.js';
import { PAYMENT_PROVIDER } from '../src/payments/ports/payment-provider.port.js';
import { FakePaymentProvider } from './fake-payment-provider.js';

/**
 * Phase 6: the transactional outbox. A financial mutation enqueues a
 * `NotificationOutbox` row in the *same* transaction as the ledger
 * write; `NotificationDispatcherService.sweep()` (normally run on a
 * timer, invoked directly here for a deterministic test) delivers it
 * afterwards via the fake delivery adapter.
 */
describe('Notification outbox (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeDelivery: FakeDeliveryAdapter;
  let dispatcher: NotificationDispatcherService;
  const runId = randomUUID().slice(0, 8);

  const email = (label: string) => `${label}-${runId}@example.com`;
  const username = (label: string) => `${label}${runId}`.slice(0, 20);

  beforeAll(async () => {
    const fakeProvider = new FakePaymentProvider();
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
    fakeDelivery = moduleFixture.get(FakeDeliveryAdapter);
    dispatcher = moduleFixture.get(NotificationDispatcherService);
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { contains: runId } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    await prisma.notificationOutbox.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.ledgerEntry.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.deposit.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  it('a completed deposit enqueues a DEPOSIT_COMPLETED row, delivered by the dispatcher sweep', async () => {
    const identifier = email('outboxdeposit');
    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: identifier,
        username: username('outboxdeposit'),
        password: 'Passw0rd1',
        dateOfBirth: '2000-01-01',
      })
      .expect(201);
    const accessToken = register.body.accessToken as string;
    const userId = register.body.user.id as string;

    const created = await request(app.getHttpServer())
      .post('/api/v1/deposits')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor: '5000' })
      .expect(201);

    const outboxBefore = await prisma.notificationOutbox.findMany({
      where: { userId },
    });
    expect(outboxBefore).toHaveLength(0);

    const providerReference = created.body.providerReference as string;
    const body = JSON.stringify({
      eventId: randomUUID(),
      eventType: 'deposit.completed',
      providerReference,
    });
    await request(app.getHttpServer())
      .post('/api/v1/payments/webhooks/monime')
      .set('x-fake-signature', 'fake-test-secret')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);

    const outboxAfter = await prisma.notificationOutbox.findMany({
      where: { userId },
    });
    expect(outboxAfter).toHaveLength(1);
    expect(outboxAfter[0].type).toBe('DEPOSIT_COMPLETED');
    expect(outboxAfter[0].status).toBe('PENDING');

    fakeDelivery.clear();
    await dispatcher.sweep();

    const outboxFinal = await prisma.notificationOutbox.findUnique({
      where: { id: outboxAfter[0].id },
    });
    expect(outboxFinal?.status).toBe('SENT');
    expect(outboxFinal?.sentAt).not.toBeNull();

    const sent = fakeDelivery.getSent();
    expect(sent.some((m) => m.to === identifier)).toBe(true);
  });
});
