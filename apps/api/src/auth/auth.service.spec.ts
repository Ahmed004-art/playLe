import {
  ConflictException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type User } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { UsersService } from '../users/users.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AppConfiguration } from '../config/configuration.js';

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'player@example.com',
    phoneNumber: null,
    username: 'playerone',
    displayName: null,
    avatarUrl: null,
    passwordHash: 'hashed-password',
    role: 'USER',
    status: 'ACTIVE',
    dateOfBirth: new Date('2000-01-01'),
    emailVerifiedAt: null,
    phoneVerifiedAt: null,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('AuthService', () => {
  let prisma: {
    user: {
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let usersService: {
    findByIdentifier: ReturnType<typeof vi.fn>;
    updateLastLogin: ReturnType<typeof vi.fn>;
  };
  let passwordService: {
    hash: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
  };
  let tokenService: {
    issueTokenPair: ReturnType<typeof vi.fn>;
    rotateRefreshToken: ReturnType<typeof vi.fn>;
    revokeRefreshToken: ReturnType<typeof vi.fn>;
    revokeAllForUser: ReturnType<typeof vi.fn>;
  };
  let configService: ConfigService<AppConfiguration, true>;
  let service: AuthService;

  beforeEach(() => {
    prisma = { user: { create: vi.fn(), update: vi.fn() } };
    usersService = { findByIdentifier: vi.fn(), updateLastLogin: vi.fn() };
    passwordService = {
      hash: vi.fn().mockResolvedValue('hashed'),
      verify: vi.fn(),
    };
    tokenService = {
      issueTokenPair: vi.fn().mockResolvedValue({
        accessToken: 'access',
        refreshToken: 'refresh',
        refreshTokenExpiresAt: new Date(),
      }),
      rotateRefreshToken: vi.fn(),
      revokeRefreshToken: vi.fn(),
      revokeAllForUser: vi.fn(),
    };
    configService = { get: () => 16 } as unknown as ConfigService<
      AppConfiguration,
      true
    >;

    service = new AuthService(
      prisma as unknown as PrismaService,
      usersService as unknown as UsersService,
      passwordService as unknown as PasswordService,
      tokenService as unknown as TokenService,
      configService,
    );
  });

  describe('register', () => {
    it('creates a user and issues a token pair', async () => {
      const created = fakeUser();
      prisma.user.create.mockResolvedValue(created);

      const result = await service.register({
        email: 'Player@Example.com',
        username: 'playerone',
        password: 'Passw0rd1',
        dateOfBirth: '2000-01-01',
      });

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'player@example.com' }),
        }),
      );
      expect(result.user).toBe(created);
      expect(result.accessToken).toBe('access');
    });

    it('rejects a date of birth under the minimum age', async () => {
      await expect(
        service.register({
          email: 'young@example.com',
          username: 'younguser',
          password: 'Passw0rd1',
          dateOfBirth: new Date().getFullYear() - 10 + '-01-01',
        }),
      ).rejects.toThrow(UnprocessableEntityException);

      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('rejects an invalid phone number', async () => {
      await expect(
        service.register({
          email: 'player@example.com',
          username: 'playerone',
          password: 'Passw0rd1',
          dateOfBirth: '2000-01-01',
          phoneNumber: 'not-a-phone',
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('maps a Prisma unique-constraint violation to a 409 Conflict', async () => {
      prisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: '6.0.0',
          meta: { target: ['email'] },
        }),
      );

      await expect(
        service.register({
          email: 'player@example.com',
          username: 'playerone',
          password: 'Passw0rd1',
          dateOfBirth: '2000-01-01',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('login', () => {
    it('logs in with correct credentials', async () => {
      const user = fakeUser();
      usersService.findByIdentifier.mockResolvedValue(user);
      passwordService.verify.mockResolvedValue(true);

      const result = await service.login({
        identifier: 'player@example.com',
        password: 'Passw0rd1',
      });

      expect(result.accessToken).toBe('access');
      expect(usersService.updateLastLogin).toHaveBeenCalledWith(user.id);
    });

    it('rejects an unknown identifier without revealing that it is unknown', async () => {
      usersService.findByIdentifier.mockResolvedValue(null);
      passwordService.verify.mockResolvedValue(false);

      await expect(
        service.login({
          identifier: 'nobody@example.com',
          password: 'whatever',
        }),
      ).rejects.toThrow(UnauthorizedException);

      // Still runs a hash comparison even though there's no user — timing mitigation.
      expect(passwordService.verify).toHaveBeenCalled();
    });

    it('rejects an incorrect password', async () => {
      usersService.findByIdentifier.mockResolvedValue(fakeUser());
      passwordService.verify.mockResolvedValue(false);

      await expect(
        service.login({ identifier: 'player@example.com', password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a suspended user even with correct credentials', async () => {
      usersService.findByIdentifier.mockResolvedValue(
        fakeUser({ status: 'SUSPENDED' }),
      );
      passwordService.verify.mockResolvedValue(true);

      await expect(
        service.login({
          identifier: 'player@example.com',
          password: 'Passw0rd1',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a disabled user even with correct credentials', async () => {
      usersService.findByIdentifier.mockResolvedValue(
        fakeUser({ status: 'DISABLED' }),
      );
      passwordService.verify.mockResolvedValue(true);

      await expect(
        service.login({
          identifier: 'player@example.com',
          password: 'Passw0rd1',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('changePassword', () => {
    it('updates the password and revokes all sessions on success', async () => {
      const user = fakeUser();
      passwordService.verify.mockResolvedValue(true);
      passwordService.hash.mockResolvedValue('new-hash');

      await service.changePassword(user, {
        currentPassword: 'Passw0rd1',
        newPassword: 'NewPassw0rd1',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: user.id },
        data: { passwordHash: 'new-hash' },
      });
      expect(tokenService.revokeAllForUser).toHaveBeenCalledWith(user.id);
    });

    it('rejects an incorrect current password and does not touch the database', async () => {
      const user = fakeUser();
      passwordService.verify.mockResolvedValue(false);

      await expect(
        service.changePassword(user, {
          currentPassword: 'wrong',
          newPassword: 'NewPassw0rd1',
        }),
      ).rejects.toThrow(UnauthorizedException);

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(tokenService.revokeAllForUser).not.toHaveBeenCalled();
    });
  });
});
