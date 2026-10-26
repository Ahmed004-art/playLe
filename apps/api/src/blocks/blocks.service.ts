import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, UserBlock } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeEmitterService } from '../realtime/realtime-emitter.service.js';
import type { CursorPage } from '../common/dto/pagination.dto.js';
import { lockUserPair } from './pair-lock.js';

/** Anything with a `userBlock` delegate: the root client or a transaction client. */
export type BlockReader = Pick<Prisma.TransactionClient, 'userBlock'>;

export interface BlockRelation {
  /** The viewer has blocked the other player. */
  blockedByViewer: boolean;
  /** The other player has blocked the viewer. */
  blockedViewer: boolean;
}

export type BlockWithUser = UserBlock & {
  blocked: { id: string; username: string; displayName: string | null };
};

interface CancelledChallenge {
  id: string;
  challengerId: string;
  opponentId: string;
}

/**
 * Player blocking (Phase 12 — ADR-026). A block is one directed row owned by
 * the blocker, but its effect is symmetric: neither player can challenge the
 * other while either has a block against the other. Blocking never touches a
 * match that is already running.
 */
@Injectable()
export class BlocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: RealtimeEmitterService,
  ) {}

  /**
   * Which direction(s) of block exist between `viewerId` and `otherId`.
   * Directionality matters to callers: the blocker is told plainly that they
   * blocked the player, while the blocked player must get the same answer as
   * for a player that does not exist (a block never reveals itself).
   */
  async relationBetween(
    viewerId: string,
    otherId: string,
    client: BlockReader = this.prisma,
  ): Promise<BlockRelation> {
    const rows = await client.userBlock.findMany({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: otherId },
          { blockerId: otherId, blockedId: viewerId },
        ],
      },
      select: { blockerId: true },
    });
    return {
      blockedByViewer: rows.some((r) => r.blockerId === viewerId),
      blockedViewer: rows.some((r) => r.blockerId === otherId),
    };
  }

  /**
   * Idempotent: blocking someone already blocked returns the existing block.
   * Under the pair lock, also cancels every PENDING challenge between the two
   * players (either direction). The friendship and friend-request cascade of
   * ADR-026 is added in the friends PR, in the same transaction.
   */
  async block(
    blockerId: string,
    blockedUserId: string,
  ): Promise<BlockWithUser> {
    if (blockerId === blockedUserId) {
      throw new BadRequestException('You cannot block yourself');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: blockedUserId },
      select: { id: true, username: true, displayName: true },
    });
    if (!target) {
      throw new NotFoundException('Player not found');
    }

    const { row, cancelled } = await this.prisma.$transaction(async (tx) => {
      await lockUserPair(tx, blockerId, blockedUserId);
      const created = await tx.userBlock.upsert({
        where: { blockerId_blockedId: { blockerId, blockedId: blockedUserId } },
        create: { blockerId, blockedId: blockedUserId },
        update: {},
      });
      return {
        row: created,
        cancelled: await this.cancelPendingChallengesBetween(
          tx,
          blockerId,
          blockedUserId,
        ),
      };
    });

    // Only after the transaction has committed - a client must never be told a
    // challenge was cancelled by a block that might still roll back.
    for (const challenge of cancelled) {
      for (const userId of [challenge.challengerId, challenge.opponentId]) {
        this.emitter.emitToUser(userId, 'challenge:resolved', {
          challengeId: challenge.id,
          status: 'CANCELLED',
        });
      }
    }

    return { ...row, blocked: target };
  }

  /**
   * Idempotent. Removes only the caller's own block: if the other player has
   * also blocked the caller, that block stays and so does its effect. Does
   * not restore anything the block cancelled.
   */
  async unblock(blockerId: string, blockedUserId: string): Promise<void> {
    if (blockerId === blockedUserId) {
      throw new BadRequestException('You cannot unblock yourself');
    }
    await this.prisma.$transaction(async (tx) => {
      await lockUserPair(tx, blockerId, blockedUserId);
      await tx.userBlock.deleteMany({
        where: { blockerId, blockedId: blockedUserId },
      });
    });
  }

  /** The caller's own blocks only - never who has blocked them. */
  async list(
    blockerId: string,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<BlockWithUser>> {
    const blocks = await this.prisma.userBlock.findMany({
      where: { blockerId },
      include: {
        blocked: { select: { id: true, username: true, displayName: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { blockedId: 'desc' }],
      take: limit + 1,
      ...(cursor
        ? {
            cursor: { blockerId_blockedId: { blockerId, blockedId: cursor } },
            skip: 1,
          }
        : {}),
    });

    const hasMore = blocks.length > limit;
    const items = hasMore ? blocks.slice(0, limit) : blocks;
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].blockedId : null,
    };
  }

  private async cancelPendingChallengesBetween(
    tx: Prisma.TransactionClient,
    userIdA: string,
    userIdB: string,
  ): Promise<CancelledChallenge[]> {
    const pending = await tx.challenge.findMany({
      where: {
        status: 'PENDING',
        OR: [
          { challengerId: userIdA, opponentId: userIdB },
          { challengerId: userIdB, opponentId: userIdA },
        ],
      },
      select: { id: true, challengerId: true, opponentId: true },
    });
    if (pending.length === 0) return [];

    // Safe against a concurrent accept: accept takes the same pair lock before
    // it claims the row, so nothing here can have been claimed since the read.
    await tx.challenge.updateMany({
      where: { id: { in: pending.map((c) => c.id) }, status: 'PENDING' },
      data: { status: 'CANCELLED', respondedAt: new Date() },
    });
    return pending;
  }
}
