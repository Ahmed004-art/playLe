import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { EligibilityService } from './eligibility.service.js';
import type { ResponsibleGamingService } from './responsible-gaming.service.js';
import type { AppConfiguration } from '../config/configuration.js';

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'player@example.com',
    phoneNumber: null,
    username: 'playerone',
    displayName: null,
    avatarUrl: null,
    passwordHash: 'hashed',
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

function fakeConfig(
  values: Partial<{
    realMoneyGamingEnabled: boolean;
    eligibilityPolicyConfigured: boolean;
    realMoneyMinimumAge: number;
  }> = {},
): ConfigService<AppConfiguration, true> {
  const defaults = {
    realMoneyGamingEnabled: true,
    eligibilityPolicyConfigured: true,
    realMoneyMinimumAge: 18,
    ...values,
  };
  return {
    get: (key: string) => {
      const field = key.split('.')[1] as keyof typeof defaults;
      return defaults[field];
    },
  } as unknown as ConfigService<AppConfiguration, true>;
}

describe('EligibilityService', () => {
  it('rejects a stake when REAL_MONEY_GAMING_ENABLED is false, even if the policy is configured', async () => {
    const responsibleGaming = {
      getActiveRestrictions: vi.fn().mockResolvedValue([]),
    };
    const service = new EligibilityService(
      fakeConfig({
        realMoneyGamingEnabled: false,
        eligibilityPolicyConfigured: true,
      }),
      responsibleGaming as unknown as ResponsibleGamingService,
    );

    await expect(service.assertCanStake(fakeUser(), 100n)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects a stake when ELIGIBILITY_POLICY_CONFIGURED is false, even if gaming is enabled — the two flags are independent', async () => {
    const responsibleGaming = {
      getActiveRestrictions: vi.fn().mockResolvedValue([]),
    };
    const service = new EligibilityService(
      fakeConfig({
        realMoneyGamingEnabled: true,
        eligibilityPolicyConfigured: false,
      }),
      responsibleGaming as unknown as ResponsibleGamingService,
    );

    await expect(service.assertCanStake(fakeUser(), 100n)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects a stake for a user younger than the configured minimum age', async () => {
    const responsibleGaming = {
      getActiveRestrictions: vi.fn().mockResolvedValue([]),
    };
    const service = new EligibilityService(
      fakeConfig({ realMoneyMinimumAge: 21 }),
      responsibleGaming as unknown as ResponsibleGamingService,
    );
    const youngUser = fakeUser({ dateOfBirth: new Date('2008-01-01') });

    await expect(service.assertCanStake(youngUser, 100n)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('allows a stake when both flags are set, the user is old enough, and no restriction applies', async () => {
    const responsibleGaming = {
      getActiveRestrictions: vi.fn().mockResolvedValue([]),
    };
    const service = new EligibilityService(
      fakeConfig(),
      responsibleGaming as unknown as ResponsibleGamingService,
    );

    await expect(
      service.assertCanStake(fakeUser(), 100n),
    ).resolves.toBeUndefined();
  });

  it('rejects a stake for a self-excluded user', async () => {
    const responsibleGaming = {
      getActiveRestrictions: vi
        .fn()
        .mockResolvedValue([{ type: 'SELF_EXCLUSION', config: {} }]),
    };
    const service = new EligibilityService(
      fakeConfig(),
      responsibleGaming as unknown as ResponsibleGamingService,
    );

    await expect(service.assertCanStake(fakeUser(), 100n)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects a deposit over the configured deposit limit', async () => {
    const responsibleGaming = {
      getActiveRestrictions: vi
        .fn()
        .mockResolvedValue([
          { type: 'DEPOSIT_LIMIT', config: { limitMinor: '5000' } },
        ]),
    };
    const service = new EligibilityService(
      fakeConfig(),
      responsibleGaming as unknown as ResponsibleGamingService,
    );

    await expect(service.assertCanDeposit('user-1', 9000n)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      service.assertCanDeposit('user-1', 5000n),
    ).resolves.toBeUndefined();
  });

  it('never blocks a withdrawal, even for a self-excluded user', () => {
    const responsibleGaming = { getActiveRestrictions: vi.fn() };
    const service = new EligibilityService(
      fakeConfig(),
      responsibleGaming as unknown as ResponsibleGamingService,
    );

    expect(() => service.assertCanWithdraw('user-1')).not.toThrow();
    expect(responsibleGaming.getActiveRestrictions).not.toHaveBeenCalled();
  });
});
