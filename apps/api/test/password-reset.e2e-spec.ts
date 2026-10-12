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

describe('Password reset (e2e)', () => {
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
    await prisma.adminAuditLog.deleteMany({
      where: { adminId: { in: userIds } },
    });
    await prisma.passwordResetToken.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.refreshToken.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  async function registerUser(label: string): Promise<{
    accessToken: string;
    refreshToken: string;
    identifier: string;
    password: string;
  }> {
    const identifier = email(label);
    const password = 'Passw0rd1';
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: identifier,
        username: username(label),
        password,
        dateOfBirth: '2000-01-01',
      })
      .expect(201);
    return {
      accessToken: res.body.accessToken,
      refreshToken: res.body.refreshToken,
      identifier,
      password,
    };
  }

  it('returns the same generic response whether or not the identifier exists', async () => {
    const known = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ identifier: email('pwknown') })
      .expect(200);

    const unknown = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ identifier: 'definitely-not-registered@example.com' })
      .expect(200);

    expect(known.body.message).toBe(unknown.body.message);
  });

  it('a requested reset delivers a code, and resetting works + revokes all sessions', async () => {
    const { identifier, refreshToken } = await registerUser('pwreset');
    fakeDelivery.clear();

    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ identifier })
      .expect(200);

    const sent = fakeDelivery.getSent();
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe(identifier);
    const token = sent[0].body.match(/code is: (\S+)/)?.[1];
    expect(token).toBeDefined();

    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, newPassword: 'NewPassw0rd2' })
      .expect(204);

    // The old refresh token is now revoked.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);

    // The new password works.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, password: 'NewPassw0rd2' })
      .expect(200);

    // The old password no longer works.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, password: 'Passw0rd1' })
      .expect(401);
  });

  it('a reset token cannot be used twice', async () => {
    const { identifier } = await registerUser('pwreused');
    fakeDelivery.clear();

    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ identifier })
      .expect(200);
    const token = fakeDelivery.getSent()[0].body.match(/code is: (\S+)/)?.[1];

    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, newPassword: 'FirstNewPass1' })
      .expect(204);

    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, newPassword: 'SecondNewPass2' })
      .expect(400);
  });

  it('rejects an unknown reset token with the same generic message as expired/used', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token: 'not-a-real-token', newPassword: 'WhateverPass1' })
      .expect(400);
  });
});
