import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Prisma, User } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { EligibilityService } from './eligibility.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { NotificationOutboxService } from '../notification-outbox/notification-outbox.service.js';
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
    windowHours: number;
  }> = {},
): ConfigService<AppConfiguration, true> {
  const defaults = {
    realMoneyGamingEnabled: true,
    eligibilityPolicyConfigured: true,
    realMoneyMinimumAge: 18,
    windowHours: 24,
    ...values,
  };
  return {
    get: (key: string) => {
      const field = key.split('.')[1] as keyof typeof defaults;
      return defaults[field];
    },
  } as unknown as ConfigService<AppConfiguration, true>;
}

/** A fake `PrismaService`/`Prisma.TransactionClient` with configurable aggregate sums. */
function fakePrisma(sums: {
  stakeHoldAvailableSum?: bigint | null;
  lossHeldSum?: bigint | null;
  depositAvailableSum?: bigint | null;
}): PrismaService {
  return {
    ledgerEntry: {
      aggregate: vi.fn(({ where }: { where: { type: string } }) => {
        if (where.type === 'STAKE_HOLD') {
          return Promise.resolve({
            _sum: { availableDeltaMinor: sums.stakeHoldAvailableSum ?? null },
          });
        }
        return Promise.resolve({
          _sum: { availableDeltaMinor: sums.depositAvailableSum ?? null },
        });
      }),
    },
    settlementEntry: {
      aggregate: vi.fn(() =>
        Promise.resolve({
          _sum: { heldDeltaMinor: sums.lossHeldSum ?? null },
        }),
      ),
    },
  } as unknown as PrismaService;
}

function fakeNotificationOutbox(): NotificationOutboxService {
  return {
    enqueueStandalone: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotificationOutboxService;
}

/**
 * Same fake, but also returns the raw `vi.fn()` typed as a plain mock —
 * asserting against *that* (rather than `notificationOutbox.enqueueStandalone`,
 * whose static type is the real class) avoids
 * `@typescript-eslint/unbound-method`'s false positive on a mocked class
 * method reference.
 */
function fakeNotificationOutboxWithSpy(): {
  outbox: NotificationOutboxService;
  enqueueStandalone: ReturnType<typeof vi.fn>;
} {
  const enqueueStandalone = vi.fn().mockResolvedValue(undefined);
  return {
    outbox: { enqueueStandalone } as unknown as NotificationOutboxService,
    enqueueStandalone,
  };
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
      fakePrisma({}),
      fakeNotificationOutbox(),
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
      fakePrisma({}),
      fakeNotificationOutbox(),
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
      fakePrisma({}),
      fakeNotificationOutbox(),
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
      fakePrisma({}),
      fakeNotificationOutbox(),
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
      fakePrisma({}),
      fakeNotificationOutbox(),
    );

    await expect(service.assertCanStake(fakeUser(), 100n)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects a deposit over the configured deposit limit (per-action ceiling)', async () => {
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
      fakePrisma({}),
      fakeNotificationOutbox(),
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
      fakePrisma({}),
      fakeNotificationOutbox(),
    );

    expect(() => service.assertCanWithdraw('user-1')).not.toThrow();
    expect(responsibleGaming.getActiveRestrictions).not.toHaveBeenCalled();
  });

  describe('rolling-window stake limit', () => {
    it('allows a stake that keeps the rolling total at or below the limit', async () => {
      const responsibleGaming = {
        getActiveRestrictions: vi
          .fn()
          .mockResolvedValue([
            { type: 'STAKE_LIMIT', config: { limitMinor: '10000' } },
          ]),
      };
      // Already staked 6000 in the window; staking 4000 more lands
      // exactly on the limit (10000) — allowed, not "exceeds".
      const service = new EligibilityService(
        fakeConfig(),
        responsibleGaming as unknown as ResponsibleGamingService,
        fakePrisma({ stakeHoldAvailableSum: -6000n }),
        fakeNotificationOutbox(),
      );

      await expect(
        service.assertCanStake(fakeUser(), 4000n),
      ).resolves.toBeUndefined();
    });

    it('rejects a stake that would push the rolling total over the limit', async () => {
      const { outbox, enqueueStandalone } = fakeNotificationOutboxWithSpy();
      const responsibleGaming = {
        getActiveRestrictions: vi
          .fn()
          .mockResolvedValue([
            { type: 'STAKE_LIMIT', config: { limitMinor: '10000' } },
          ]),
      };
      const service = new EligibilityService(
        fakeConfig(),
        responsibleGaming as unknown as ResponsibleGamingService,
        fakePrisma({ stakeHoldAvailableSum: -8000n }),
        outbox,
      );

      await expect(service.assertCanStake(fakeUser(), 4000n)).rejects.toThrow(
        /rolling stake limit/i,
      );
      expect(enqueueStandalone).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          type: 'RESPONSIBLE_GAMING_LIMIT_REACHED',
          payload: expect.objectContaining({ limitType: 'STAKE_LIMIT' }),
        }),
      );
    });

    it('ignores the rolling check entirely when no STAKE_LIMIT is configured', async () => {
      const responsibleGaming = {
        getActiveRestrictions: vi.fn().mockResolvedValue([]),
      };
      const service = new EligibilityService(
        fakeConfig(),
        responsibleGaming as unknown as ResponsibleGamingService,
        fakePrisma({ stakeHoldAvailableSum: -1_000_000n }),
        fakeNotificationOutbox(),
      );

      await expect(
        service.assertCanStake(fakeUser(), 4000n),
      ).resolves.toBeUndefined();
    });

    it('passes the given transaction client through to the aggregate query (authoritative, lock-consistent read)', async () => {
      const responsibleGaming = {
        getActiveRestrictions: vi
          .fn()
          .mockResolvedValue([
            { type: 'STAKE_LIMIT', config: { limitMinor: '10000' } },
          ]),
      };
      const txAggregate = vi.fn().mockResolvedValue({
        _sum: { availableDeltaMinor: 0n },
      });
      const tx = {
        ledgerEntry: { aggregate: txAggregate },
        settlementEntry: { aggregate: vi.fn().mockResolvedValue({}) },
      } as unknown as Prisma.TransactionClient;
      const service = new EligibilityService(
        fakeConfig(),
        responsibleGaming as unknown as ResponsibleGamingService,
        fakePrisma({ stakeHoldAvailableSum: -999_999n }), // the default db — must NOT be used
        fakeNotificationOutbox(),
      );

      await expect(
        service.assertCanStake(fakeUser(), 100n, tx),
      ).resolves.toBeUndefined();
      expect(txAggregate).toHaveBeenCalled();
    });
  });

  describe('rolling-window loss limit', () => {
    it('allows a new stake when the rolling loss total is below the limit', async () => {
      const responsibleGaming = {
        getActiveRestrictions: vi
          .fn()
          .mockResolvedValue([
            { type: 'LOSS_LIMIT', config: { limitMinor: '5000' } },
          ]),
      };
      const service = new EligibilityService(
        fakeConfig(),
        responsibleGaming as unknown as ResponsibleGamingService,
        fakePrisma({ lossHeldSum: -4999n }),
        fakeNotificationOutbox(),
      );

      await expect(
        service.assertCanStake(fakeUser(), 100n),
      ).resolves.toBeUndefined();
    });

    it('rejects a new stake once the rolling loss total reaches the limit', async () => {
      const { outbox, enqueueStandalone } = fakeNotificationOutboxWithSpy();
      const responsibleGaming = {
        getActiveRestrictions: vi
          .fn()
          .mockResolvedValue([
            { type: 'LOSS_LIMIT', config: { limitMinor: '5000' } },
          ]),
      };
      const service = new EligibilityService(
        fakeConfig(),
        responsibleGaming as unknown as ResponsibleGamingService,
        fakePrisma({ lossHeldSum: -5000n }),
        outbox,
      );

      await expect(service.assertCanStake(fakeUser(), 100n)).rejects.toThrow(
        /loss limit/i,
      );
      expect(enqueueStandalone).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'RESPONSIBLE_GAMING_LIMIT_REACHED',
          payload: expect.objectContaining({ limitType: 'LOSS_LIMIT' }),
        }),
      );
    });

    it('a win does not count toward the rolling loss sum (the aggregate only ever sums LOSER-role entries)', async () => {
      // Modeled by the fake simply returning null/0 — the real query's
      // `role: 'LOSER'` filter is what the e2e suite proves end-to-end
      // against a real settlement; see match-stakes-limits.e2e-spec.ts.
      const responsibleGaming = {
        getActiveRestrictions: vi
          .fn()
          .mockResolvedValue([
            { type: 'LOSS_LIMIT', config: { limitMinor: '5000' } },
          ]),
      };
      const service = new EligibilityService(
        fakeConfig(),
        responsibleGaming as unknown as ResponsibleGamingService,
        fakePrisma({ lossHeldSum: null }),
        fakeNotificationOutbox(),
      );

      await expect(
        service.assertCanStake(fakeUser(), 100n),
      ).resolves.toBeUndefined();
    });
  });

  describe('rolling-window deposit limit', () => {
    it('rejects a deposit that would push the rolling total over the limit', async () => {
      const responsibleGaming = {
        getActiveRestrictions: vi
          .fn()
          .mockResolvedValue([
            { type: 'DEPOSIT_LIMIT', config: { limitMinor: '10000' } },
          ]),
      };
      const service = new EligibilityService(
        fakeConfig(),
        responsibleGaming as unknown as ResponsibleGamingService,
        fakePrisma({ depositAvailableSum: 8000n }),
        fakeNotificationOutbox(),
      );

      await expect(service.assertCanDeposit('user-1', 4000n)).rejects.toThrow(
        /rolling deposit limit/i,
      );
    });

    it('allows a deposit that keeps the rolling total at or below the limit', async () => {
      const responsibleGaming = {
        getActiveRestrictions: vi
          .fn()
          .mockResolvedValue([
            { type: 'DEPOSIT_LIMIT', config: { limitMinor: '10000' } },
          ]),
      };
      const service = new EligibilityService(
        fakeConfig(),
        responsibleGaming as unknown as ResponsibleGamingService,
        fakePrisma({ depositAvailableSum: 6000n }),
        fakeNotificationOutbox(),
      );

      await expect(
        service.assertCanDeposit('user-1', 4000n),
      ).resolves.toBeUndefined();
    });
  });
});
