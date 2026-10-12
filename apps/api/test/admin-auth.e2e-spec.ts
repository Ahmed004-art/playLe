import { randomUUID } from 'node:crypto';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Phase 6: httpOnly-cookie admin sessions + double-submit CSRF. Proves
 * the admin dashboard no longer needs to store a token in
 * JS-readable storage, while every existing Bearer-token-based admin
 * client/test (see `wallet.e2e-spec.ts`) keeps working unchanged (the
 * global `CsrfGuard` only ever activates for cookie-authenticated
 * requests).
 */
describe('Admin session cookies + CSRF (e2e)', () => {
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
    app.use(cookieParser());
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
    await prisma.ledgerEntry.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  async function registerAdmin(
    label: string,
  ): Promise<{ userId: string; identifier: string; password: string }> {
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
    const userId = res.body.user.id as string;
    await prisma.user.update({
      where: { id: userId },
      data: { role: 'ADMIN' },
    });
    return { userId, identifier, password };
  }

  function extractCookie(setCookieHeader: string[], name: string): string {
    const raw = setCookieHeader.find((c) => c.startsWith(`${name}=`));
    if (!raw) throw new Error(`Cookie ${name} not set`);
    return raw.split(';')[0].split('=')[1];
  }

  it('logs in via cookies, never returning a token in the response body', async () => {
    const { identifier, password } = await registerAdmin('cookielogin');

    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/session/login')
      .send({ identifier, password })
      .expect(200);

    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    expect(res.body.email).toBe(identifier);

    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(setCookie.some((c) => c.startsWith('admin_access_token='))).toBe(
      true,
    );
    expect(setCookie.some((c) => c.startsWith('admin_refresh_token='))).toBe(
      true,
    );
    expect(setCookie.some((c) => c.startsWith('admin_csrf_token='))).toBe(true);
    // httpOnly cookies must say so.
    const accessCookie = setCookie.find((c) =>
      c.startsWith('admin_access_token='),
    )!;
    expect(accessCookie.toLowerCase()).toContain('httponly');
    const csrfCookie = setCookie.find((c) =>
      c.startsWith('admin_csrf_token='),
    )!;
    expect(csrfCookie.toLowerCase()).not.toContain('httponly');
  });

  it('rejects login for valid credentials that are not an admin account', async () => {
    const identifier = email('notadmin');
    const password = 'Passw0rd1';
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: identifier,
        username: username('notadmin'),
        password,
        dateOfBirth: '2000-01-01',
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/session/login')
      .send({ identifier, password })
      .expect(401);

    expect(res.body.message).toMatch(/invalid credentials/i);
  });

  it('the access cookie authenticates an existing admin endpoint', async () => {
    const { identifier, password } = await registerAdmin('cookieauth');
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/session/login')
      .send({ identifier, password })
      .expect(200);
    const setCookie = login.headers['set-cookie'] as unknown as string[];
    const accessCookie = extractCookie(setCookie, 'admin_access_token');

    await request(app.getHttpServer())
      .get('/api/v1/admin/session/me')
      .set('Cookie', `admin_access_token=${accessCookie}`)
      .expect(200);
  });

  it('rejects a mutating admin request made with the cookie but no CSRF header', async () => {
    const { identifier, password, userId } = await registerAdmin('csrfmissing');
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/session/login')
      .send({ identifier, password })
      .expect(200);
    const setCookie = login.headers['set-cookie'] as unknown as string[];
    const accessCookie = extractCookie(setCookie, 'admin_access_token');

    await request(app.getHttpServer())
      .post(`/api/v1/admin/wallets/${userId}/adjustments`)
      .set('Cookie', `admin_access_token=${accessCookie}`)
      .send({
        direction: 'CREDIT',
        amountMinor: '100',
        reason: 'should be rejected',
      })
      .expect(403);
  });

  it('accepts a mutating admin request with a matching X-CSRF-Token header', async () => {
    const { identifier, password, userId } = await registerAdmin('csrfok');
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/session/login')
      .send({ identifier, password })
      .expect(200);
    const setCookie = login.headers['set-cookie'] as unknown as string[];
    const accessCookie = extractCookie(setCookie, 'admin_access_token');
    const csrfCookie = extractCookie(setCookie, 'admin_csrf_token');

    await request(app.getHttpServer())
      .post(`/api/v1/admin/wallets/${userId}/adjustments`)
      .set(
        'Cookie',
        `admin_access_token=${accessCookie}; admin_csrf_token=${csrfCookie}`,
      )
      .set('X-CSRF-Token', csrfCookie)
      .send({
        direction: 'CREDIT',
        amountMinor: '100',
        reason: 'CSRF header matches cookie',
      })
      .expect(200);
  });

  it('rejects a mutating admin request whose CSRF header does not match the cookie', async () => {
    const { identifier, password, userId } =
      await registerAdmin('csrfmismatch');
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/session/login')
      .send({ identifier, password })
      .expect(200);
    const setCookie = login.headers['set-cookie'] as unknown as string[];
    const accessCookie = extractCookie(setCookie, 'admin_access_token');
    const csrfCookie = extractCookie(setCookie, 'admin_csrf_token');

    await request(app.getHttpServer())
      .post(`/api/v1/admin/wallets/${userId}/adjustments`)
      .set(
        'Cookie',
        `admin_access_token=${accessCookie}; admin_csrf_token=${csrfCookie}`,
      )
      .set('X-CSRF-Token', 'not-the-real-token')
      .send({
        direction: 'CREDIT',
        amountMinor: '100',
        reason: 'CSRF header mismatch',
      })
      .expect(403);
  });

  it('rotates the session via the refresh cookie and records an audit entry', async () => {
    const { identifier, password, userId } =
      await registerAdmin('cookierefresh');
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/session/login')
      .send({ identifier, password })
      .expect(200);
    const loginCookies = login.headers['set-cookie'] as unknown as string[];
    const refreshCookie = extractCookie(loginCookies, 'admin_refresh_token');
    const csrfCookie = extractCookie(loginCookies, 'admin_csrf_token');

    // `/session/refresh` is a mutating cookie-authenticated request, so
    // it requires the CSRF header exactly like any other admin route.
    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/admin/session/refresh')
      .set(
        'Cookie',
        `admin_refresh_token=${refreshCookie}; admin_csrf_token=${csrfCookie}`,
      )
      .set('X-CSRF-Token', csrfCookie)
      .expect(200);
    const refreshedCookies = refreshed.headers[
      'set-cookie'
    ] as unknown as string[];
    const newAccessCookie = extractCookie(
      refreshedCookies,
      'admin_access_token',
    );

    await request(app.getHttpServer())
      .get('/api/v1/admin/session/me')
      .set('Cookie', `admin_access_token=${newAccessCookie}`)
      .expect(200);

    const logs = await prisma.adminAuditLog.findMany({
      where: { adminId: userId, action: 'SESSION_REFRESH' },
    });
    expect(logs.length).toBeGreaterThan(0);
  });

  it('logout revokes the session and clears cookies', async () => {
    const { identifier, password, userId } =
      await registerAdmin('cookielogout');
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/session/login')
      .send({ identifier, password })
      .expect(200);
    const loginCookies = login.headers['set-cookie'] as unknown as string[];
    const accessCookie = extractCookie(loginCookies, 'admin_access_token');
    const refreshCookie = extractCookie(loginCookies, 'admin_refresh_token');
    const csrfCookie = extractCookie(loginCookies, 'admin_csrf_token');

    await request(app.getHttpServer())
      .post('/api/v1/admin/session/logout')
      .set(
        'Cookie',
        `admin_access_token=${accessCookie}; admin_refresh_token=${refreshCookie}; admin_csrf_token=${csrfCookie}`,
      )
      .set('X-CSRF-Token', csrfCookie)
      .expect(204);

    // The now-revoked refresh token can no longer rotate a new session.
    await request(app.getHttpServer())
      .post('/api/v1/admin/session/refresh')
      .set(
        'Cookie',
        `admin_refresh_token=${refreshCookie}; admin_csrf_token=${csrfCookie}`,
      )
      .set('X-CSRF-Token', csrfCookie)
      .expect(401);

    const logs = await prisma.adminAuditLog.findMany({
      where: { adminId: userId, action: 'LOGOUT' },
    });
    expect(logs.length).toBeGreaterThan(0);
  });

  it('records a LOGIN_FAILED audit entry for a wrong password', async () => {
    const { identifier } = await registerAdmin('cookiefailaudit');

    await request(app.getHttpServer())
      .post('/api/v1/admin/session/login')
      .send({ identifier, password: 'WrongPassword1' })
      .expect(401);

    const logs = await prisma.adminAuditLog.findMany({
      where: { action: 'LOGIN_FAILED', detail: { contains: identifier } },
    });
    expect(logs.length).toBeGreaterThan(0);
  });
});
