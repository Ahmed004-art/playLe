import { randomUUID } from 'node:crypto';
import {
  Controller,
  Get,
  INestApplication,
  Module,
  UseGuards,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../src/auth/guards/roles.guard.js';
import { Roles } from '../src/auth/decorators/roles.decorator.js';

/**
 * A throwaway controller mounted only inside this test process — never
 * part of the shipped API. It exists purely to prove the reusable
 * JwtAuthGuard + RolesGuard + @Roles() primitives correctly enforce
 * role-based authorization over real HTTP, since Phase 2 does not ship
 * any real admin-only product endpoint yet (see Phase 2 spec, "do not
 * build a full admin dashboard yet"). It imports AuthModule so the guards
 * it references resolve their real dependencies (TokenService,
 * UsersService) exactly as they would in the real app.
 */
@Controller('test-admin-only')
class AdminOnlyTestController {
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  ping() {
    return { ok: true };
  }
}

@Module({
  imports: [AuthModule],
  controllers: [AdminOnlyTestController],
})
class AdminOnlyTestModule {}

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const runId = randomUUID().slice(0, 8);

  const email = (label: string) => `${label}-${runId}@example.com`;
  const username = (label: string) => `${label}${runId}`.slice(0, 20);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, AdminOnlyTestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Mirror main.ts's real bootstrap so this test exercises the actual
    // production URL shape (/api/v1/...), not just the bare controller paths.
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
    await prisma.user.deleteMany({ where: { email: { contains: runId } } });
    await app.close();
  });

  const validRegisterBody = (label: string) => ({
    email: email(label),
    username: username(label),
    password: 'Passw0rd1',
    dateOfBirth: '2000-01-01',
  });

  it('registers a new account and returns a safe user plus tokens', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send(validRegisterBody('register'))
      .expect(201);

    expect(res.body.user.email).toBe(email('register'));
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
  });

  it('rejects registering the same email twice', async () => {
    const body = validRegisterBody('dupe');
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send(body)
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ ...body, username: username('dupe2') })
      .expect(409);

    expect(res.body.message).toMatch(/already exists/i);
  });

  it('rejects registering the same username twice', async () => {
    const body = validRegisterBody('dupeuser');
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send(body)
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ ...body, email: email('dupeuser2') })
      .expect(409);
  });

  it('rejects registration under the minimum age', async () => {
    const tooYoung = new Date();
    tooYoung.setFullYear(tooYoung.getFullYear() - 10);

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        ...validRegisterBody('young'),
        dateOfBirth: tooYoung.toISOString().slice(0, 10),
      })
      .expect(422);

    expect(res.body.message).toMatch(/at least \d+ years old/);
  });

  it('rejects a malformed registration payload', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'not-an-email',
        username: 'ab',
        password: 'short',
        dateOfBirth: 'not-a-date',
      })
      .expect(400);
  });

  describe('full session lifecycle', () => {
    const label = 'lifecycle';
    let refreshToken: string;
    let accessToken: string;

    beforeAll(async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(validRegisterBody(label))
        .expect(201);
    });

    it('logs in with correct credentials', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: email(label), password: 'Passw0rd1' })
        .expect(200);

      accessToken = res.body.accessToken;
      refreshToken = res.body.refreshToken;
      expect(accessToken).toBeTruthy();
      expect(refreshToken).toBeTruthy();
    });

    it('rejects an invalid password', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: email(label), password: 'WrongPassword1' })
        .expect(401);
    });

    it('retrieves the authenticated user via /me', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.email).toBe(email(label));
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('rejects /me with no token', async () => {
      await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    });

    it('rejects /me with an invalid token', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });

    it('rotates the refresh token', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(200);

      expect(res.body.refreshToken).not.toBe(refreshToken);
      const oldRefreshToken = refreshToken;
      refreshToken = res.body.refreshToken;
      accessToken = res.body.accessToken;

      // Reusing the old, now-rotated-away token must fail.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: oldRefreshToken })
        .expect(401);
    });

    it('logs out and revokes the refresh token', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken })
        .expect(204);

      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(401);
    });
  });

  describe('password change', () => {
    const label = 'pwchange';
    let accessToken: string;
    let refreshToken: string;

    beforeAll(async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(validRegisterBody(label))
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: email(label), password: 'Passw0rd1' })
        .expect(200);

      accessToken = res.body.accessToken;
      refreshToken = res.body.refreshToken;
    });

    it('rejects an incorrect current password', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          currentPassword: 'WrongPassword1',
          newPassword: 'NewPassw0rd1',
        })
        .expect(401);
    });

    it('changes the password and revokes existing sessions', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: 'Passw0rd1', newPassword: 'NewPassw0rd1' })
        .expect(204);

      // The refresh token issued before the password change must no longer work.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(401);

      // Logging in with the new password must work.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: email(label), password: 'NewPassw0rd1' })
        .expect(200);
    });
  });

  describe('suspended / disabled accounts', () => {
    it('rejects login for a suspended user', async () => {
      const label = 'suspended';
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(validRegisterBody(label))
        .expect(201);

      await prisma.user.update({
        where: { email: email(label) },
        data: { status: 'SUSPENDED' },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: email(label), password: 'Passw0rd1' })
        .expect(401);

      expect(res.body.message).toMatch(/suspended/i);
    });

    it('rejects an already-issued access token once the account is disabled', async () => {
      const label = 'disabled';
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(validRegisterBody(label))
        .expect(201);

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: email(label), password: 'Passw0rd1' })
        .expect(200);

      await prisma.user.update({
        where: { email: email(label) },
        data: { status: 'DISABLED' },
      });

      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(401);
    });
  });

  describe('role-based authorization', () => {
    it('allows an ADMIN to reach an admin-only route', async () => {
      const label = 'adminuser';
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(validRegisterBody(label))
        .expect(201);

      await prisma.user.update({
        where: { email: email(label) },
        data: { role: 'ADMIN' },
      });

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: email(label), password: 'Passw0rd1' })
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/v1/test-admin-only')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(200);
    });

    it('a normal USER cannot reach an admin-only route, even with a valid token', async () => {
      const label = 'plainuser';
      const register = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(validRegisterBody(label))
        .expect(201);

      await request(app.getHttpServer())
        .get('/api/v1/test-admin-only')
        .set('Authorization', `Bearer ${register.body.accessToken}`)
        .expect(403);
    });

    it('rejects an admin-only route with no token at all', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/test-admin-only')
        .expect(401);
    });
  });
});
