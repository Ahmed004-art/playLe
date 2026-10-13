import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Challenge, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { GamesService } from '../games/games.service.js';
import { UsersService } from '../users/users.service.js';
import { MatchesService } from '../matches/matches.service.js';
import { RealtimeEmitterService } from '../realtime/realtime-emitter.service.js';
import { MatchStakesService } from '../match-stakes/match-stakes.service.js';
import { EligibilityService } from '../eligibility/eligibility.service.js';
import type { StakeRequestDto } from '../match-stakes/dto/stake-request.dto.js';
import type { CursorPage } from '../common/dto/pagination.dto.js';
import type { AppConfiguration } from '../config/configuration.js';

@Injectable()
export class ChallengesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gamesService: GamesService,
    private readonly usersService: UsersService,
    private readonly matchesService: MatchesService,
    private readonly emitter: RealtimeEmitterService,
    private readonly matchStakesService: MatchStakesService,
    private readonly eligibilityService: EligibilityService,
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  async create(
    gameId: string,
    challenger: User,
    opponentUserId: string,
    stakeRequest?: StakeRequestDto,
  ): Promise<Challenge> {
    const challengerId = challenger.id;
    if (challengerId === opponentUserId) {
      throw new ConflictException('You cannot challenge yourself');
    }

    await this.gamesService.findEnabledById(gameId);

    const opponent = await this.usersService.findById(opponentUserId);
    if (!opponent || opponent.status !== 'ACTIVE') {
      throw new NotFoundException('Opponent not found');
    }

    // Advisory, matching `MatchmakingService.join`'s own early check
    // (Phase 9 — ADR-024) — fails fast with a friendly message for the
    // common case. The authoritative, race-safe guard is
    // `createMatchGuarded`, run again at accept time.
    const challengerAlreadyInMatch = await this.prisma.matchPlayer.findFirst({
      where: {
        userId: challengerId,
        match: { status: { in: ['WAITING', 'READY', 'ACTIVE'] } },
      },
    });
    if (challengerAlreadyInMatch) {
      throw new ConflictException(
        'You are already in an active or pending match',
      );
    }

    const existing = await this.prisma.challenge.findFirst({
      where: {
        gameId,
        status: 'PENDING',
        OR: [
          { challengerId, opponentId: opponentUserId },
          { challengerId: opponentUserId, opponentId: challengerId },
        ],
      },
    });
    if (existing) {
      throw new ConflictException(
        'There is already a pending challenge between you and this player for this game',
      );
    }

    const stake = stakeRequest
      ? await this.matchStakesService.validateStakeRequest(
          challenger,
          stakeRequest,
        )
      : undefined;

    const expiryMs = this.configService.get('matches.challengeExpiryMs', {
      infer: true,
    });

    const challenge = await this.prisma.challenge.create({
      data: {
        gameId,
        challengerId,
        opponentId: opponentUserId,
        expiresAt: new Date(Date.now() + expiryMs),
        stakeAmountMinor: stake?.amountMinor,
        stakeCurrency: stake?.currency,
      },
    });

    this.emitter.emitToUser(opponentUserId, 'challenge:received', {
      challengeId: challenge.id,
      gameId,
      challengerId,
    });

    return challenge;
  }

  async list(
    userId: string,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<Challenge>> {
    const challenges = await this.prisma.challenge.findMany({
      where: { OR: [{ challengerId: userId }, { opponentId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = challenges.length > limit;
    const items = hasMore ? challenges.slice(0, limit) : challenges;

    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async accept(userId: string, challengeId: string): Promise<Challenge> {
    const challenge = await this.findForParticipant(userId, challengeId);
    if (challenge.opponentId !== userId) {
      throw new ForbiddenException('Only the challenged player can accept');
    }

    // The challenger's eligibility was already checked when they
    // *created* this challenge (`create`, via `validateStakeRequest`) —
    // but that says nothing about the opponent's own restriction state.
    // A self-excluded (or over their own rolling limit) opponent must
    // not be able to enter a staked match just by accepting an incoming
    // challenge rather than initiating one themselves.
    if (challenge.stakeAmountMinor != null) {
      const opponent = await this.usersService.findById(userId);
      if (!opponent) {
        throw new NotFoundException('Challenge not found');
      }
      await this.eligibilityService.assertCanStake(
        opponent,
        challenge.stakeAmountMinor,
      );
    }

    const resolved = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.challenge.updateMany({
        where: {
          id: challengeId,
          status: 'PENDING',
          expiresAt: { gt: new Date() },
        },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      });
      if (count === 0) {
        throw new ConflictException('This challenge is no longer pending');
      }

      const game = await tx.game.findUniqueOrThrow({
        where: { id: challenge.gameId },
      });
      // `createMatchGuarded`, not `createMatch` (Phase 9 — ADR-024): also
      // closes the race where either party already holds a conflicting
      // WAITING/READY/ACTIVE match formed via a different path (another
      // challenge-accept, or matchmaking) between this challenge being
      // created and now. A conflict here rolls back the whole
      // transaction, including the `status: 'ACCEPTED'` claim above, so
      // the challenge is left genuinely `PENDING` for a later attempt
      // rather than stuck half-resolved.
      const match = await this.matchesService.createMatchGuarded(
        game,
        [challenge.challengerId, challenge.opponentId],
        tx,
        challenge.stakeAmountMinor != null && challenge.stakeCurrency
          ? {
              amountMinor: challenge.stakeAmountMinor,
              currency: challenge.stakeCurrency,
            }
          : undefined,
      );

      return tx.challenge.update({
        where: { id: challengeId },
        data: { matchId: match.id },
      });
    });

    // Emitted only after the transaction has actually committed — a
    // client must never be told a challenge resolved into a match that
    // might still roll back (same principle as the Phase 6 notification
    // outbox: never signal before the underlying write is durable).
    this.emitter.emitToUser(challenge.challengerId, 'challenge:resolved', {
      challengeId,
      status: 'ACCEPTED',
      matchId: resolved.matchId,
    });
    this.emitter.emitToUser(challenge.opponentId, 'challenge:resolved', {
      challengeId,
      status: 'ACCEPTED',
      matchId: resolved.matchId,
    });

    return resolved;
  }

  async decline(userId: string, challengeId: string): Promise<Challenge> {
    const challenge = await this.findForParticipant(userId, challengeId);
    if (challenge.opponentId !== userId) {
      throw new ForbiddenException('Only the challenged player can decline');
    }

    const { count } = await this.prisma.challenge.updateMany({
      where: { id: challengeId, status: 'PENDING' },
      data: { status: 'DECLINED', respondedAt: new Date() },
    });
    if (count === 0) {
      throw new ConflictException('This challenge is no longer pending');
    }

    this.emitter.emitToUser(challenge.challengerId, 'challenge:resolved', {
      challengeId,
      status: 'DECLINED',
    });

    return this.prisma.challenge.findUniqueOrThrow({
      where: { id: challengeId },
    });
  }

  async cancel(userId: string, challengeId: string): Promise<Challenge> {
    const challenge = await this.findForParticipant(userId, challengeId);
    if (challenge.challengerId !== userId) {
      throw new ForbiddenException('Only the challenger can cancel');
    }

    const { count } = await this.prisma.challenge.updateMany({
      where: { id: challengeId, status: 'PENDING' },
      data: { status: 'CANCELLED', respondedAt: new Date() },
    });
    if (count === 0) {
      throw new ConflictException('This challenge is no longer pending');
    }

    this.emitter.emitToUser(challenge.opponentId, 'challenge:resolved', {
      challengeId,
      status: 'CANCELLED',
    });

    return this.prisma.challenge.findUniqueOrThrow({
      where: { id: challengeId },
    });
  }

  /** 404s for anyone who isn't the challenger or the opponent — IDOR-safe. */
  private async findForParticipant(
    userId: string,
    challengeId: string,
  ): Promise<Challenge> {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
    });
    if (
      !challenge ||
      (challenge.challengerId !== userId && challenge.opponentId !== userId)
    ) {
      throw new NotFoundException('Challenge not found');
    }
    return challenge;
  }
}
