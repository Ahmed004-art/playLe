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
import { generateTotp } from '../src/mfa/totp.util.js';

/**
 * Phase 6: TOTP MFA — enrollment never enforces anything until
 * confirmed, login pauses for a challenge once enrolled, both a TOTP
 * code and a single-use recovery code can complete that challenge, and
 * disabling requires a fresh valid code (not just a valid access token).
 */
describe('MFA (e2e)', () => {
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
    await prisma.adminAuditLog.deleteMany({
      where: { adminId: { in: userIds } },
    });
    await prisma.mfaRecoveryCode.deleteMany({
      where: { mfaTotpCredential: { userId: { in: userIds } } },
    });
    await prisma.mfaTotpCredential.deleteMany({
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
    userId: string;
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
      userId: res.body.user.id,
      identifier,
      password,
    };
  }

  async function enrollAndConfirm(
    accessToken: string,
  ): Promise<{ secret: string; recoveryCodes: string[] }> {
    const enroll = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/enroll')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const secret = enroll.body.secret as string;

    const confirm = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/confirm')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: generateTotp(secret) })
      .expect(200);

    return { secret, recoveryCodes: confirm.body.recoveryCodes as string[] };
  }

  it('enrollment does not enforce anything until confirmed', async () => {
    const { accessToken, identifier, password } =
      await registerUser('mfaunconfirmed');

    await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/enroll')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // Still logs straight in — no challenge, since enrollment was never confirmed.
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, password })
      .expect(200);
    expect(login.body.accessToken).toBeDefined();
    expect(login.body.mfaRequired).toBeUndefined();
  });

  it('reports status before and after confirmation', async () => {
    const { accessToken } = await registerUser('mfastatus');

    const before = await request(app.getHttpServer())
      .get('/api/v1/auth/mfa/status')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(before.body.enabled).toBe(false);

    await enrollAndConfirm(accessToken);

    const after = await request(app.getHttpServer())
      .get('/api/v1/auth/mfa/status')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(after.body.enabled).toBe(true);
  });

  it('a confirmed enrollment pauses login for an MFA challenge, completed by a TOTP code', async () => {
    const { accessToken, identifier, password } =
      await registerUser('mfalogin');
    const { secret } = await enrollAndConfirm(accessToken);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, password })
      .expect(200);
    expect(login.body.mfaRequired).toBe(true);
    expect(login.body.accessToken).toBeUndefined();

    const verified = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/verify')
      .send({
        mfaChallengeToken: login.body.mfaChallengeToken,
        code: generateTotp(secret),
      })
      .expect(200);
    expect(verified.body.accessToken).toBeDefined();
    expect(verified.body.user.id).toBeDefined();
  });

  it('rejects an invalid code at the login challenge', async () => {
    const { accessToken, identifier, password } =
      await registerUser('mfabadcode');
    await enrollAndConfirm(accessToken);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, password })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaChallengeToken: login.body.mfaChallengeToken, code: '000000' })
      .expect(401);
  });

  it('a single-use recovery code completes the challenge exactly once', async () => {
    const { accessToken, identifier, password } =
      await registerUser('mfarecovery');
    const { recoveryCodes } = await enrollAndConfirm(accessToken);
    const recoveryCode = recoveryCodes[0];

    const login1 = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, password })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/verify')
      .send({
        mfaChallengeToken: login1.body.mfaChallengeToken,
        code: recoveryCode,
      })
      .expect(200);

    const login2 = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, password })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/verify')
      .send({
        mfaChallengeToken: login2.body.mfaChallengeToken,
        code: recoveryCode,
      })
      .expect(401);
  });

  it('disable requires a fresh valid TOTP code, not just the access token', async () => {
    const { accessToken } = await registerUser('mfadisable');
    const { secret } = await enrollAndConfirm(accessToken);

    await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/disable')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: '000000' })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/disable')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: generateTotp(secret) })
      .expect(204);

    const status = await request(app.getHttpServer())
      .get('/api/v1/auth/mfa/status')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(status.body.enabled).toBe(false);
  });

  it('resuming an unconfirmed enrollment returns the same secret', async () => {
    const { accessToken } = await registerUser('mfaresume');

    const first = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/enroll')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const second = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/enroll')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(second.body.secret).toBe(first.body.secret);
  });
});
