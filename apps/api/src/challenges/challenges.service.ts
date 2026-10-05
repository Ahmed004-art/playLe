import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Challenge } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { GamesService } from '../games/games.service.js';
import { UsersService } from '../users/users.service.js';
import { MatchesService } from '../matches/matches.service.js';
import { RealtimeEmitterService } from '../realtime/realtime-emitter.service.js';
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
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  async create(
    gameId: string,
    challengerId: string,
    opponentUserId: string,
  ): Promise<Challenge> {
    if (challengerId === opponentUserId) {
      throw new ConflictException('You cannot challenge yourself');
    }

    await this.gamesService.findEnabledById(gameId);

    const opponent = await this.usersService.findById(opponentUserId);
    if (!opponent || opponent.status !== 'ACTIVE') {
      throw new NotFoundException('Opponent not found');
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

    const expiryMs = this.configService.get('matches.challengeExpiryMs', {
      infer: true,
    });

    const challenge = await this.prisma.challenge.create({
      data: {
        gameId,
        challengerId,
        opponentId: opponentUserId,
        expiresAt: new Date(Date.now() + expiryMs),
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

    return this.prisma.$transaction(async (tx) => {
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
      const match = await this.matchesService.createMatch(
        game,
        [challenge.challengerId, challenge.opponentId],
        tx,
      );

      const resolved = await tx.challenge.update({
        where: { id: challengeId },
        data: { matchId: match.id },
      });

      this.emitter.emitToUser(challenge.challengerId, 'challenge:resolved', {
        challengeId,
        status: 'ACCEPTED',
        matchId: match.id,
      });
      this.emitter.emitToUser(challenge.opponentId, 'challenge:resolved', {
        challengeId,
        status: 'ACCEPTED',
        matchId: match.id,
      });

      return resolved;
    });
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
