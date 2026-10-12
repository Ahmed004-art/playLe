import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import { isOldEnough } from '../auth/utils/age.util.js';
import type { AppConfiguration } from '../config/configuration.js';
import { ResponsibleGamingService } from './responsible-gaming.service.js';

/**
 * The single, centralized real-money eligibility policy — see ADR-021.
 * Nothing outside this service should duplicate these checks; before
 * Phase 6 they were inline in `MatchStakesService` (now delegated here).
 *
 * `REAL_MONEY_GAMING_ENABLED` and `ELIGIBILITY_POLICY_CONFIGURED` are
 * two *independent* flags that must both be true — the existing
 * account-creation age gate (`AUTH_MIN_AGE_YEARS`, default 16) is a
 * product gate, not proof that a 16-year-old may lawfully participate
 * in real-money gaming in any given jurisdiction. This codebase cannot
 * make that legal determination; it only enforces whatever the owner
 * has configured (`REAL_MONEY_MINIMUM_AGE`) once they explicitly flip
 * `ELIGIBILITY_POLICY_CONFIGURED` to record that a real policy exists.
 *
 * A limit here (`STAKE_LIMIT`/`DEPOSIT_LIMIT`/`LOSS_LIMIT`) is enforced
 * as a per-action ceiling, not a rolling-period sum — a deliberate,
 * documented simplification (see `ResponsibleGamingService`), not a
 * claim that this is a complete spend-tracking system.
 */
@Injectable()
export class EligibilityService {
  constructor(
    private readonly configService: ConfigService<AppConfiguration, true>,
    private readonly responsibleGaming: ResponsibleGamingService,
  ) {}

  async assertCanStake(user: User, amountMinor: bigint): Promise<void> {
    this.assertRealMoneyGamingPermitted(user);

    const restrictions = await this.responsibleGaming.getActiveRestrictions(
      user.id,
    );

    this.assertNoBlockingRestriction(restrictions, [
      'SELF_EXCLUSION',
      'COOLING_OFF',
    ]);

    const stakeLimit = restrictions.find((r) => r.type === 'STAKE_LIMIT');
    this.assertWithinAmountLimit(stakeLimit, amountMinor, 'stake');
  }

  async assertCanDeposit(userId: string, amountMinor: bigint): Promise<void> {
    const restrictions =
      await this.responsibleGaming.getActiveRestrictions(userId);

    this.assertNoBlockingRestriction(restrictions, [
      'SELF_EXCLUSION',
      'COOLING_OFF',
    ]);

    const depositLimit = restrictions.find((r) => r.type === 'DEPOSIT_LIMIT');
    this.assertWithinAmountLimit(depositLimit, amountMinor, 'deposit');
  }

  /**
   * Withdrawals are deliberately **not** blocked by self-exclusion or
   * cooling-off — letting an at-risk user get their own money *out* is
   * the responsible-gaming-correct behavior, not a loophole. No checks
   * here today; kept as an explicit method (rather than no method at
   * all) so a future real policy requirement has an obvious home.
   */
  assertCanWithdraw(_userId: string): void {
    // Intentionally empty — see doc comment above.
  }

  private assertRealMoneyGamingPermitted(user: User): void {
    const gamingEnabled = this.configService.get(
      'stakes.realMoneyGamingEnabled',
      { infer: true },
    );
    const policyConfigured = this.configService.get(
      'stakes.eligibilityPolicyConfigured',
      { infer: true },
    );

    if (!gamingEnabled || !policyConfigured) {
      throw new ForbiddenException('Real-money gaming is not enabled');
    }

    const minimumAge = this.configService.get('stakes.realMoneyMinimumAge', {
      infer: true,
    });
    if (!isOldEnough(user.dateOfBirth, minimumAge)) {
      throw new ForbiddenException(
        `You must be at least ${minimumAge} to play for real money`,
      );
    }
  }

  private assertNoBlockingRestriction(
    restrictions: { type: string }[],
    blockingTypes: string[],
  ): void {
    const hit = restrictions.find((r) => blockingTypes.includes(r.type));
    if (hit) {
      throw new ForbiddenException(
        hit.type === 'SELF_EXCLUSION'
          ? 'This account has self-excluded from real-money play'
          : 'This account is in a cooling-off period',
      );
    }
  }

  private assertWithinAmountLimit(
    restriction: { config: unknown } | undefined,
    amountMinor: bigint,
    label: string,
  ): void {
    if (!restriction) return;
    const config = restriction.config as { limitMinor?: string } | null;
    if (!config?.limitMinor) return;

    const limit = BigInt(config.limitMinor);
    if (amountMinor > limit) {
      throw new ForbiddenException(
        `This ${label} exceeds your configured limit of ${limit} minor units`,
      );
    }
  }
}
