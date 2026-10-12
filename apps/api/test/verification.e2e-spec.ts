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

describe('Email/phone verification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeDelivery: FakeDeliveryAdapter;
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
    fakeDelivery = moduleFixture.get(FakeDeliveryAdapter);
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { contains: runId } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    await prisma.verificationChallenge.deleteMany({
      where: { userId: { in: userIds } },
    });
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

  it('confirming a correct email code sets emailVerifiedAt', async () => {
    const { accessToken, userId } = await registerUser('verifyemail');
    fakeDelivery.clear();

    await request(app.getHttpServer())
      .post('/api/v1/auth/verification/request')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ channel: 'EMAIL' })
      .expect(200);

    const code = fakeDelivery.getSent()[0].body.match(/code is: (\d+)/)?.[1];
    expect(code).toMatch(/^\d{6}$/);

    await request(app.getHttpServer())
      .post('/api/v1/auth/verification/confirm')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ channel: 'EMAIL', code })
      .expect(204);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  it('rejects a wrong code and throttles after too many attempts', async () => {
    const { accessToken } = await registerUser('verifywrong');

    await request(app.getHttpServer())
      .post('/api/v1/auth/verification/request')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ channel: 'EMAIL' })
      .expect(200);

    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/verification/confirm')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ channel: 'EMAIL', code: '000000' })
        .expect(401);
    }

    // Even the real code no longer works — the challenge was consumed
    // after exhausting attempts; a new one must be requested.
    const code = fakeDelivery
      .getSent()
      .at(-1)
      ?.body.match(/code is: (\d+)/)?.[1];
    await request(app.getHttpServer())
      .post('/api/v1/auth/verification/confirm')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ channel: 'EMAIL', code })
      .expect(401);
  });

  it('requires a phone number on file to request an SMS code', async () => {
    const { accessToken } = await registerUser('verifynophone');

    await request(app.getHttpServer())
      .post('/api/v1/auth/verification/request')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ channel: 'SMS' })
      .expect(400);
  });

  it('a newer request supersedes an older unconsumed challenge', async () => {
    const { accessToken } = await registerUser('verifysuperseded');
    fakeDelivery.clear();

    await request(app.getHttpServer())
      .post('/api/v1/auth/verification/request')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ channel: 'EMAIL' })
      .expect(200);
    const firstCode = fakeDelivery
      .getSent()[0]
      .body.match(/code is: (\d+)/)?.[1];

    await request(app.getHttpServer())
      .post('/api/v1/auth/verification/request')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ channel: 'EMAIL' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/verification/confirm')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ channel: 'EMAIL', code: firstCode })
      .expect(401);
  });
});
