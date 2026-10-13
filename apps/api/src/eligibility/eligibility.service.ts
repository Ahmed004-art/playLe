import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  type ResponsibleGamingRestriction,
  type User,
} from '@prisma/client';
import { isOldEnough } from '../auth/utils/age.util.js';
import type { AppConfiguration } from '../config/configuration.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationOutboxService } from '../notification-outbox/notification-outbox.service.js';
import { ResponsibleGamingService } from './responsible-gaming.service.js';

/**
 * The single, centralized real-money eligibility policy — see ADR-021
 * and, for the Phase 8 rolling-window extension, ADR-023. Nothing
 * outside this service should duplicate these checks.
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
 * `STAKE_LIMIT`/`DEPOSIT_LIMIT`/`LOSS_LIMIT` are each enforced twice:
 * a per-action ceiling (unchanged since Phase 6 — "this one action is
 * too big") *and*, as of Phase 8, a rolling-window sum (see
 * `assertWithinRollingStakeLimit`/`assertWithinRollingLossLimit`/
 * `assertWithinRollingDepositLimit` — "your recent total is too big").
 * See ADR-023 for exactly what counts as spending/a loss, the window
 * semantics, and why it's a fixed platform parameter rather than
 * user-configurable.
 */
@Injectable()
export class EligibilityService {
  constructor(
    private readonly configService: ConfigService<AppConfiguration, true>,
    private readonly responsibleGaming: ResponsibleGamingService,
    private readonly prisma: PrismaService,
    private readonly notificationOutbox: NotificationOutboxService,
  ) {}

  /**
   * `db` is the *authoritative* read when it's a locked transaction's
   * `Prisma.TransactionClient` (see `MatchStakesService.confirmStake`,
   * which calls this *after* `LedgerService.lockWallet` — so two
   * concurrent stakes for the same user are serialized by that same
   * wallet lock, and the second one's rolling sum always sees the
   * first's already-applied `STAKE_HOLD`). Called with the default
   * (`this.prisma`, no lock) it's only an early, advisory check — see
   * `MatchStakesService.validateStakeRequest`'s doc comment for why
   * that's fine for a pre-match-formation check.
   */
  async assertCanStake(
    user: User,
    amountMinor: bigint,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
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
    await this.assertWithinRollingStakeLimit(
      db,
      user.id,
      stakeLimit,
      amountMinor,
    );

    const lossLimit = restrictions.find((r) => r.type === 'LOSS_LIMIT');
    await this.assertWithinRollingLossLimit(db, user.id, lossLimit);
  }

  async assertCanDeposit(
    userId: string,
    amountMinor: bigint,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const restrictions =
      await this.responsibleGaming.getActiveRestrictions(userId);

    this.assertNoBlockingRestriction(restrictions, [
      'SELF_EXCLUSION',
      'COOLING_OFF',
    ]);

    const depositLimit = restrictions.find((r) => r.type === 'DEPOSIT_LIMIT');
    this.assertWithinAmountLimit(depositLimit, amountMinor, 'deposit');
    await this.assertWithinRollingDepositLimit(
      db,
      userId,
      depositLimit,
      amountMinor,
    );
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

  /**
   * Read-only visibility into the user's own current rolling-window
   * usage — what the mobile/admin UI shows as "you've staked/lost/
   * deposited X of your Y limit this period" (see
   * `ResponsibleGamingController.usage`/`AdminResponsibleGamingController`).
   * Computed from the same authoritative tables and the same window as
   * the enforcement checks above, so it can never drift from what's
   * actually being enforced. Returned regardless of whether a limit is
   * currently configured for each category — the caller decides how to
   * present "no limit set" vs. "0 of your limit used".
   */
  async getRollingUsage(userId: string): Promise<{
    windowHours: number;
    stakeHeldMinor: bigint;
    lossMinor: bigint;
    depositedMinor: bigint;
  }> {
    const windowStart = this.rollingWindowStart();

    const [stakeResult, lossResult, depositResult] = await Promise.all([
      this.prisma.ledgerEntry.aggregate({
        where: {
          userId,
          type: 'STAKE_HOLD',
          createdAt: { gte: windowStart },
        },
        _sum: { availableDeltaMinor: true },
      }),
      this.prisma.settlementEntry.aggregate({
        where: { userId, role: 'LOSER', createdAt: { gte: windowStart } },
        _sum: { heldDeltaMinor: true },
      }),
      this.prisma.ledgerEntry.aggregate({
        where: { userId, type: 'DEPOSIT', createdAt: { gte: windowStart } },
        _sum: { availableDeltaMinor: true },
      }),
    ]);

    return {
      windowHours: this.windowHours(),
      stakeHeldMinor: -(stakeResult._sum.availableDeltaMinor ?? 0n),
      lossMinor: -(lossResult._sum.heldDeltaMinor ?? 0n),
      depositedMinor: depositResult._sum.availableDeltaMinor ?? 0n,
    };
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
    const limit = this.limitMinorOf(restriction);
    if (limit === null) return;
    if (amountMinor > limit) {
      throw new ForbiddenException(
        `This ${label} exceeds your configured limit of ${limit} minor units`,
      );
    }
  }

  /**
   * Authoritative rolling-window spend check: the sum of every
   * `STAKE_HOLD` ledger entry for this user in the last
   * `responsibleGaming.windowHours` hours, plus this new stake, must
   * not exceed the configured `STAKE_LIMIT`. `STAKE_HOLD` is recorded
   * the instant a stake is *confirmed* (committed), independent of the
   * eventual win/loss/draw/cancel outcome — see ADR-023, "what counts
   * as spending".
   */
  private async assertWithinRollingStakeLimit(
    db: Prisma.TransactionClient,
    userId: string,
    restriction: ResponsibleGamingRestriction | undefined,
    newAmountMinor: bigint,
  ): Promise<void> {
    const limit = this.limitMinorOf(restriction);
    if (limit === null) return;

    const result = await db.ledgerEntry.aggregate({
      where: {
        userId,
        type: 'STAKE_HOLD',
        createdAt: { gte: this.rollingWindowStart() },
      },
      _sum: { availableDeltaMinor: true },
    });
    // availableDeltaMinor is negative for a hold (money leaves available).
    const existingStakedMinor = -(result._sum.availableDeltaMinor ?? 0n);

    if (existingStakedMinor + newAmountMinor > limit) {
      await this.notifyLimitReached(userId, 'STAKE_LIMIT');
      throw new ForbiddenException(
        `This stake would put your total staked amount over the last ${this.windowHours()} hours above your configured rolling stake limit`,
      );
    }
  }

  /**
   * Authoritative rolling-window loss check: once the sum of every
   * `SettlementEntry` with `role: 'LOSER'` for this user in the last
   * `responsibleGaming.windowHours` hours reaches the configured
   * `LOSS_LIMIT`, no *new* stake may be confirmed until the window
   * rolls forward — the standard real-world loss-limit semantic
   * ("you've lost your configured amount for this period; no more
   * play until it resets"), not a per-stake projection (the outcome of
   * a not-yet-played stake is unknown). A win, draw, or cancellation
   * never contributes — only an actual `LOSER` settlement entry does,
   * and `Settlement.matchStakeId`'s uniqueness means a retried/
   * recovered settlement can never create a second one. See ADR-023.
   */
  private async assertWithinRollingLossLimit(
    db: Prisma.TransactionClient,
    userId: string,
    restriction: ResponsibleGamingRestriction | undefined,
  ): Promise<void> {
    const limit = this.limitMinorOf(restriction);
    if (limit === null) return;

    const result = await db.settlementEntry.aggregate({
      where: {
        userId,
        role: 'LOSER',
        createdAt: { gte: this.rollingWindowStart() },
      },
      _sum: { heldDeltaMinor: true },
    });
    // heldDeltaMinor is negative for a loss (the held stake is consumed).
    const existingLossMinor = -(result._sum.heldDeltaMinor ?? 0n);

    if (existingLossMinor >= limit) {
      await this.notifyLimitReached(userId, 'LOSS_LIMIT');
      throw new ForbiddenException(
        `You have reached your configured loss limit for the last ${this.windowHours()} hours`,
      );
    }
  }

  /**
   * Rolling-window deposit check, evaluated against already-`COMPLETED`
   * deposits only (a `DEPOSIT` ledger entry exists only once a deposit
   * actually completes — see `DepositsService.completeFromProviderEvent`).
   * **Known limitation** (documented, not silently accepted): unlike
   * stakes, a deposit's completion is asynchronous and provider-driven
   * (a webhook arriving after this check already passed), so this
   * cannot be made fully concurrency-safe the way the stake/loss checks
   * are — there is no wallet lock to hold against a webhook that hasn't
   * arrived yet. It still correctly blocks *initiating* a new deposit
   * once the rolling sum of already-completed deposits would exceed the
   * limit, which is the common case. See ADR-023.
   */
  private async assertWithinRollingDepositLimit(
    db: Prisma.TransactionClient,
    userId: string,
    restriction: ResponsibleGamingRestriction | undefined,
    newAmountMinor: bigint,
  ): Promise<void> {
    const limit = this.limitMinorOf(restriction);
    if (limit === null) return;

    const result = await db.ledgerEntry.aggregate({
      where: {
        userId,
        type: 'DEPOSIT',
        createdAt: { gte: this.rollingWindowStart() },
      },
      _sum: { availableDeltaMinor: true },
    });
    const existingDepositedMinor = result._sum.availableDeltaMinor ?? 0n;

    if (existingDepositedMinor + newAmountMinor > limit) {
      await this.notifyLimitReached(userId, 'DEPOSIT_LIMIT');
      throw new ForbiddenException(
        `This deposit would put your total deposits over the last ${this.windowHours()} hours above your configured rolling deposit limit`,
      );
    }
  }

  private limitMinorOf(
    restriction: { config: unknown } | undefined,
  ): bigint | null {
    if (!restriction) return null;
    const config = restriction.config as { limitMinor?: string } | null;
    if (!config?.limitMinor) return null;
    return BigInt(config.limitMinor);
  }

  private windowHours(): number {
    return this.configService.get('responsibleGaming.windowHours', {
      infer: true,
    });
  }

  private rollingWindowStart(): Date {
    return new Date(Date.now() - this.windowHours() * 60 * 60 * 1000);
  }

  private async notifyLimitReached(
    userId: string,
    limitType: 'STAKE_LIMIT' | 'LOSS_LIMIT' | 'DEPOSIT_LIMIT',
  ): Promise<void> {
    await this.notificationOutbox.enqueueStandalone({
      userId,
      type: 'RESPONSIBLE_GAMING_LIMIT_REACHED',
      payload: { limitType, windowHours: this.windowHours() },
    });
  }
}
