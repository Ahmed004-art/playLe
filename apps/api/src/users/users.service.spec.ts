import { describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';
import { UsersService } from './users.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('UsersService.toSafeUser', () => {
  it('strips passwordHash and keeps every other field', () => {
    const service = new UsersService({} as PrismaService);
    const user: User = {
      id: 'user-1',
      email: 'player@example.com',
      phoneNumber: null,
      username: 'playerone',
      displayName: null,
      avatarUrl: null,
      passwordHash: 'super-secret-hash',
      role: 'USER',
      status: 'ACTIVE',
      dateOfBirth: new Date('2000-01-01'),
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const safe = service.toSafeUser(user);

    expect(safe).not.toHaveProperty('passwordHash');
    expect(safe.id).toBe(user.id);
    expect(safe.email).toBe(user.email);
    expect(JSON.stringify(safe)).not.toContain('super-secret-hash');
  });
});
