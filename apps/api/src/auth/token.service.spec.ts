import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { TokenService } from './token.service.js';
import type { AppConfiguration } from '../config/configuration.js';

interface FakeRow {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  replacedByHash: string | null;
  revokedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  userAgent?: string;
  ipAddress?: string;
}

const FAKE_USER = {
  id: 'user-1',
  role: 'USER' as const,
  status: 'ACTIVE' as const,
};

function createFakePrisma() {
  const rows: FakeRow[] = [];

  return {
    refreshToken: {
      create: ({
        data,
      }: {
        data: Omit<
          FakeRow,
          'id' | 'createdAt' | 'revokedAt' | 'replacedByHash'
        >;
      }) => {
        const row: FakeRow = {
          id: randomUUID(),
          revokedAt: null,
          replacedByHash: null,
          createdAt: new Date(),
          ...data,
        };
        rows.push(row);
        return row;
      },
      findUnique: ({
        where,
        include,
      }: {
        where: { tokenHash: string };
        include?: { user?: boolean };
      }) => {
        const row = rows.find((r) => r.tokenHash === where.tokenHash);
        if (!row) return null;
        return include?.user ? { ...row, user: FAKE_USER } : row;
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeRow>;
      }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      updateMany: ({
        where,
        data,
      }: {
        where: { familyId?: string; userId?: string; revokedAt?: null };
        data: Partial<FakeRow>;
      }) => {
        const matches = rows.filter(
          (r) =>
            (where.familyId === undefined || r.familyId === where.familyId) &&
            (where.userId === undefined || r.userId === where.userId) &&
            (where.revokedAt === undefined || r.revokedAt === where.revokedAt),
        );
        for (const row of matches) Object.assign(row, data);
        return { count: matches.length };
      },
    },
    _rows: rows,
  };
}

function createTokenService(prisma: ReturnType<typeof createFakePrisma>) {
  const configService = {
    get: (key: string) => {
      const config: Partial<AppConfiguration['auth']> = {
        accessTokenSecret: 'test-secret-at-least-32-characters-long',
        accessTokenTtl: '15m',
        refreshTokenTtlDays: 30,
        minAgeYears: 16,
      };
      const field = key.replace('auth.', '') as keyof AppConfiguration['auth'];
      return config[field];
    },
  } as unknown as ConfigService<AppConfiguration, true>;

  return new TokenService(new JwtService(), configService, prisma as never);
}

describe('TokenService', () => {
  let prisma: ReturnType<typeof createFakePrisma>;
  let service: TokenService;

  beforeEach(() => {
    prisma = createFakePrisma();
    service = createTokenService(prisma);
  });

  it('signs and verifies an access token round-trip', () => {
    const token = service.signAccessToken(FAKE_USER);
    const payload = service.verifyAccessToken(token);
    expect(payload.sub).toBe(FAKE_USER.id);
    expect(payload.role).toBe('USER');
  });

  it('rejects a garbage access token', () => {
    expect(() => service.verifyAccessToken('not-a-real-token')).toThrow(
      UnauthorizedException,
    );
  });

  it('issues a refresh token that can be rotated exactly once', async () => {
    const issued = await service.issueRefreshToken(FAKE_USER.id);
    const rotated = await service.rotateRefreshToken(issued.token);

    expect(rotated.refreshToken).not.toBe(issued.token);
    expect(rotated.user.id).toBe(FAKE_USER.id);
  });

  it('detects reuse of an already-rotated refresh token and revokes the whole family', async () => {
    const issued = await service.issueRefreshToken(FAKE_USER.id);
    const rotated = await service.rotateRefreshToken(issued.token);

    // Reusing the original (now-revoked) token must fail...
    await expect(service.rotateRefreshToken(issued.token)).rejects.toThrow(
      UnauthorizedException,
    );

    // ...and must have revoked the token that replaced it too (family-wide revocation).
    await expect(
      service.rotateRefreshToken(rotated.refreshToken),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an unknown refresh token', async () => {
    await expect(service.rotateRefreshToken('unknown-token')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an expired refresh token', async () => {
    const issued = await service.issueRefreshToken(FAKE_USER.id);
    const row = prisma._rows.find((r) => r.userId === FAKE_USER.id)!;
    row.expiresAt = new Date(Date.now() - 1000);

    await expect(service.rotateRefreshToken(issued.token)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('revokes a specific token on logout, scoped to its owning user', async () => {
    const issued = await service.issueRefreshToken(FAKE_USER.id);

    const revokedForWrongUser = await service.revokeRefreshToken(
      issued.token,
      'someone-else',
    );
    expect(revokedForWrongUser).toBe(false);

    const revoked = await service.revokeRefreshToken(
      issued.token,
      FAKE_USER.id,
    );
    expect(revoked).toBe(true);

    await expect(service.rotateRefreshToken(issued.token)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('revokes every active session for a user', async () => {
    const a = await service.issueRefreshToken(FAKE_USER.id);
    const b = await service.issueRefreshToken(FAKE_USER.id);

    await service.revokeAllForUser(FAKE_USER.id);

    await expect(service.rotateRefreshToken(a.token)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(service.rotateRefreshToken(b.token)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
