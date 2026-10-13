import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  MatchStake,
  MatchStakePlayer,
  Settlement,
  SettlementEntry,
  User,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { RealtimeEmitterService } from '../realtime/realtime-emitter.service.js';
import { EligibilityService } from '../eligibility/eligibility.service.js';
import { parseAmountMinor } from '../common/money.js';
import { MATCH_TRANSACTION_OPTIONS } from '../common/prisma-transaction.constants.js';
import type { AppConfiguration } from '../config/configuration.js';
import type { StakeRequestDto } from './dto/stake-request.dto.js';
import type { StakeSpec } from '../matches/matches.service.js';

export type MatchStakeWithPlayers = MatchStake & {
  players: MatchStakePlayer[];
};

@Injectable()
export class MatchStakesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly walletService: WalletService,
    private readonly emitter: RealtimeEmitterService,
    private readonly configService: ConfigService<AppConfiguration, true>,
    private readonly eligibilityService: EligibilityService,
  ) {}

  /**
   * Validates a requested stake against every eligibility rule (Phase 5
   * spec sections 8-9) *before* a match is even formed — called by
   * matchmaking-join and challenge-create. Real-money eligibility is
   * deliberately separate from the general account age gate
   * (`auth.minAgeYears`, checked at registration) — see
   * docs/decisions/ADR-016-match-financial-architecture.md. The balance
   * check here is advisory (better UX, early rejection); the
   * authoritative check happens again at `confirmStake` via the ledger
   * lock, since the balance can change in between.
   */
  async validateStakeRequest(
    user: User,
    dto: StakeRequestDto,
  ): Promise<StakeSpec> {
    const amountMinor = parseAmountMinor(dto.amountMinor);
    await this.eligibilityService.assertCanStake(user, amountMinor);

    const minStake = this.configService.get('stakes.minStakeMinor', {
      infer: true,
    });
    const maxStake = this.configService.get('stakes.maxStakeMinor', {
      infer: true,
    });
    if (amountMinor < minStake || amountMinor > maxStake) {
      throw new UnprocessableEntityException(
        `Stake must be between ${minStake} and ${maxStake} minor units`,
      );
    }

    const wallet = await this.walletService.getByUserId(user.id);
    if (wallet.availableBalanceMinor < amountMinor) {
      throw new UnprocessableEntityException('Insufficient available balance');
    }

    return { amountMinor, currency: dto.currency };
  }

  /** IDOR-safe: 404s for anyone who isn't a participant in this match's stake. */
  async getForParticipant(
    userId: string,
    matchId: string,
  ): Promise<MatchStakeWithPlayers | null> {
    const stake = await this.prisma.matchStake.findUnique({
      where: { matchId },
      include: { players: true },
    });
    if (!stake) return null;
    if (!stake.players.some((p) => p.userId === userId)) {
      throw new NotFoundException('Match not found');
    }
    return stake;
  }

  /**
   * The combined financial view for `GET /matches/:id/financial` — the
   * stake (if any) and its settlement (if the match has finished and
   * settled). `null` for both simply means ordinary free play. 404s for
   * a non-participant via `getForParticipant`'s IDOR check, but first
   * confirms the match itself exists and the user is a real participant
   * even when there's no stake at all.
   */
  async getFinancialView(
    userId: string,
    matchId: string,
  ): Promise<{
    stake: MatchStakeWithPlayers | null;
    settlement: (Settlement & { entries: SettlementEntry[] }) | null;
  }> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { players: true },
    });
    if (!match || !match.players.some((p) => p.userId === userId)) {
      throw new NotFoundException('Match not found');
    }

    const stake = await this.prisma.matchStake.findUnique({
      where: { matchId },
      include: { players: true },
    });
    if (!stake) return { stake: null, settlement: null };

    const settlement = await this.prisma.settlement.findUnique({
      where: { matchStakeId: stake.id },
      include: { entries: true },
    });

    return { stake, settlement };
  }

  /** Admin visibility: no participant restriction. */
  async getFinancialViewAdmin(matchId: string): Promise<{
    stake: MatchStakeWithPlayers | null;
    settlement: (Settlement & { entries: SettlementEntry[] }) | null;
  }> {
    const stake = await this.prisma.matchStake.findUnique({
      where: { matchId },
      include: { players: true },
    });
    if (!stake) return { stake: null, settlement: null };

    const settlement = await this.prisma.settlement.findUnique({
      where: { matchStakeId: stake.id },
      include: { entries: true },
    });

    return { stake, settlement };
  }

  /**
   * Commits one player's stake: locks their wallet, applies the
   * `STAKE_HOLD` ledger entry, and marks this player's row held — all
   * atomically. Idempotent (a retry after the first hold just returns
   * the current state) and concurrency-safe (a conditional `updateMany`
   * ensures only one of two simultaneous confirm requests actually
   * holds the money, mirroring `ChallengesService`'s accept/decline
   * pattern). Once every player has held, flips both the `MatchStake`
   * (`HELD`/`ACTIVE`) and the `Match` (`WAITING` -> `ACTIVE`) and pushes
   * `match:state` so both clients know gameplay can begin.
   */
  async confirmStake(
    user: User,
    matchId: string,
  ): Promise<MatchStakeWithPlayers> {
    const stake = await this.getForParticipant(user.id, matchId);
    if (!stake) {
      throw new NotFoundException('Match not found');
    }

    const alreadyHeld = stake.players.find((p) => p.userId === user.id);
    if (alreadyHeld?.heldAt) {
      return stake;
    }

    await this.eligibilityService.assertCanStake(user, stake.stakeAmountMinor);

    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { status: true, gameId: true },
    });
    if (!match || match.status !== 'WAITING') {
      throw new UnprocessableEntityException(
        'This match is no longer waiting for stakes to be confirmed',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const walletId = await this.walletService.getWalletIdForUser(tx, user.id);

      // Lock the wallet before the conditional update — same ordering
      // discipline as every other hold in this codebase (see
      // LedgerService.lockWallet). Re-checking eligibility *here*, with
      // `tx`, is what makes the Phase 8 rolling-window stake/loss checks
      // actually concurrency-safe: two concurrent `confirmStake` calls
      // for the same user (different matches) both need this same
      // wallet lock, so the second one's rolling sum is guaranteed to
      // see the first's already-applied `STAKE_HOLD` — see
      // EligibilityService.assertCanStake's doc comment and ADR-023.
      await this.ledgerService.lockWallet(tx, walletId);
      await this.eligibilityService.assertCanStake(
        user,
        stake.stakeAmountMinor,
        tx,
      );

      const { count } = await tx.matchStakePlayer.updateMany({
        where: { matchStakeId: stake.id, userId: user.id, heldAt: null },
        data: { heldAt: new Date() },
      });
      if (count === 0) {
        // Lost a race to a concurrent confirm request for the same
        // player — the other request already held it.
        return;
      }

      await this.ledgerService.applyEntry(tx, walletId, {
        type: 'STAKE_HOLD',
        availableDeltaMinor: -stake.stakeAmountMinor,
        heldDeltaMinor: stake.stakeAmountMinor,
        relatedMatchStakeId: stake.id,
      });
    }, MATCH_TRANSACTION_OPTIONS);

    const refreshed = await this.prisma.matchStake.findUniqueOrThrow({
      where: { id: stake.id },
      include: { players: true },
    });

    const everyoneHeld = refreshed.players.every((p) => p.heldAt !== null);
    if (!everyoneHeld) {
      return refreshed;
    }

    const now = new Date();
    const activatedMatch = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.matchStake.updateMany({
        where: { id: stake.id, status: 'PENDING' },
        data: { status: 'ACTIVE', heldAt: now },
      });
      if (count === 0) {
        // Another concurrent confirm already finished this transition.
        return null;
      }
      // Starts the turn clock the instant the match actually becomes
      // playable (Phase 9 — ADR-024), not at `WAITING` creation time,
      // since no one can move until every stake is held.
      const game = await tx.game.findUnique({
        where: { id: match.gameId },
        select: { turnTimeoutSeconds: true },
      });
      const turnDeadlineAt = game?.turnTimeoutSeconds
        ? new Date(now.getTime() + game.turnTimeoutSeconds * 1000)
        : null;
      return tx.match.update({
        where: { id: matchId },
        data: {
          status: 'ACTIVE',
          readyAt: now,
          startedAt: now,
          turnDeadlineAt,
        },
      });
    });

    if (activatedMatch) {
      this.emitter.emitToMatch(matchId, 'match:state', {
        matchId,
        stateVersion: activatedMatch.stateVersion,
        state: activatedMatch.state,
        status: activatedMatch.status,
      });
    }

    return this.prisma.matchStake.findUniqueOrThrow({
      where: { id: stake.id },
      include: { players: true },
    });
  }
}
