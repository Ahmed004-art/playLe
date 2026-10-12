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

describe('Session management (e2e)', () => {
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
    await prisma.refreshToken.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  async function registerUser(
    label: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: email(label),
        username: username(label),
        password: 'Passw0rd1',
        dateOfBirth: '2000-01-01',
      })
      .expect(201);
    return {
      accessToken: res.body.accessToken,
      refreshToken: res.body.refreshToken,
    };
  }

  it('lists active sessions, including a second login as a separate session', async () => {
    const { accessToken } = await registerUser('sesslist');
    const identifier = email('sesslist');

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, password: 'Passw0rd1' })
      .expect(200);

    const list = await request(app.getHttpServer())
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(list.body.length).toBeGreaterThanOrEqual(2);
    expect(list.body[0]).toHaveProperty('id');
    expect(list.body[0]).not.toHaveProperty('tokenHash');
  });

  it('revoking one session by id does not affect other sessions', async () => {
    const { accessToken, refreshToken: firstRefreshToken } =
      await registerUser('sessrevokeone');
    const identifier = email('sessrevokeone');

    const second = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, password: 'Passw0rd1' })
      .expect(200);

    const list = await request(app.getHttpServer())
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(2);
    // Listed newest-first — the oldest (register's own) session is last.
    const targetId = list.body[list.body.length - 1].id as string;

    await request(app.getHttpServer())
      .post(`/api/v1/auth/sessions/${targetId}/revoke`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    const after = await request(app.getHttpServer())
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(
      after.body.find((s: { id: string }) => s.id === targetId),
    ).toBeUndefined();

    // The revoked (register's) session's refresh token no longer works...
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: firstRefreshToken })
      .expect(401);

    // ...but the still-active second login's session is unaffected.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: second.body.refreshToken })
      .expect(200);
  });

  it('cannot revoke another user’s session (IDOR)', async () => {
    const { accessToken } = await registerUser('sessowner');
    const identifier = email('sessowner');
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, password: 'Passw0rd1' })
      .expect(200);
    const list = await request(app.getHttpServer())
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const victimSessionId = list.body[0].id as string;

    const { accessToken: intruderToken } = await registerUser('sessintruder');

    await request(app.getHttpServer())
      .post(`/api/v1/auth/sessions/${victimSessionId}/revoke`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(404);
  });

  it('revoke-all ends every session', async () => {
    const { accessToken } = await registerUser('sessrevokeall');
    const identifier = email('sessrevokeall');
    const second = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, password: 'Passw0rd1' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/sessions/revoke-all')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: second.body.refreshToken })
      .expect(401);
  });
});
