import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { FriendRequest, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { BlocksService } from '../blocks/blocks.service.js';
import { isHiddenFromSummaries } from '../blocks/block-visibility.js';
import { lockUserPair, orderPair, pairKeyOf } from '../blocks/pair-lock.js';
import {
  PresenceService,
  type PresenceStatus,
} from '../realtime/presence.service.js';
import { RealtimeEmitterService } from '../realtime/realtime-emitter.service.js';
import type { CursorPage } from '../common/dto/pagination.dto.js';
import { lockFriendSlots } from './friend-slot-lock.js';
import {
  MAX_FRIENDS,
  MAX_OUTGOING_PENDING_REQUESTS,
} from './friends.constants.js';

export interface PlayerSummary {
  id: string;
  username: string;
  displayName: string | null;
}

type SummaryWithStatus = PlayerSummary & { status: string };

/** A friend request with both players' public summaries attached. */
export type FriendRequestView = FriendRequest & {
  requester: PlayerSummary;
  addressee: PlayerSummary;
};

export type FriendRequestDirection = 'incoming' | 'outgoing';

export type FriendPresence = PresenceStatus | 'OFFLINE';

export interface FriendView {
  friend: PlayerSummary;
  presence: FriendPresence;
  friendsSince: Date;
}

const SUMMARY_SELECT = {
  id: true,
  username: true,
  displayName: true,
} as const;

const SUMMARY_WITH_STATUS_SELECT = { ...SUMMARY_SELECT, status: true } as const;

const REQUEST_INCLUDE = {
  requester: { select: SUMMARY_WITH_STATUS_SELECT },
  addressee: { select: SUMMARY_WITH_STATUS_SELECT },
} as const;

const NO_LONGER_PENDING = 'This friend request is no longer pending';

const summaryOf = (u: SummaryWithStatus | PlayerSummary): PlayerSummary => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
});

/** Strips `status` (used only to filter) so it can never reach a response. */
function toView(
  request: FriendRequest & {
    requester: SummaryWithStatus | PlayerSummary;
    addressee: SummaryWithStatus | PlayerSummary;
  },
): FriendRequestView {
  return {
    ...request,
    requester: summaryOf(request.requester),
    addressee: summaryOf(request.addressee),
  };
}

/**
 * Friend requests, friendships and friend presence (Phase 12 PR 3 - ADR-026).
 *
 * **Locking.** Every mutation of a pair's relationship (send, accept, remove,
 * and - in `BlocksService` - block/unblock) takes the pair advisory lock FIRST
 * (`lockUserPair`), then, where a friend/request count is read and written, the
 * two players' friend slots (`lockFriendSlots`), then touches rows. Never the
 * other way round, and never a row claim before the pair lock. That one order
 * is what keeps these paths and challenge acceptance (pair lock, then
 * challenge row, then per-user match locks) from deadlocking.
 *
 * **Events** are emitted only after the transaction commits, to the one player
 * concerned, with a minimal payload (request id and a public summary).
 */
@Injectable()
export class FriendsService {
  private readonly logger = new Logger(FriendsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blocksService: BlocksService,
    private readonly presenceService: PresenceService,
    private readonly emitter: RealtimeEmitterService,
  ) {}

  /**
   * Sends a request. If the other player already has an open request to the
   * sender (a crossed request) it is accepted instead and exactly one
   * friendship results. A player who has blocked the sender looks exactly like
   * a player who does not exist; the blocker is told plainly.
   */
  async sendRequest(
    requesterId: string,
    targetId: string,
  ): Promise<FriendRequestView> {
    if (requesterId === targetId) {
      throw new BadRequestException(
        'You cannot send a friend request to yourself',
      );
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: SUMMARY_WITH_STATUS_SELECT,
    });
    if (!target || target.status !== 'ACTIVE') {
      throw new NotFoundException('Player not found');
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockUserPair(tx, requesterId, targetId);
      await lockFriendSlots(tx, requesterId, targetId);

      const relation = await this.blocksService.relationBetween(
        requesterId,
        targetId,
        tx,
      );
      if (relation.blockedByViewer) {
        throw new ConflictException('You have blocked this player');
      }
      if (relation.blockedViewer) {
        throw new NotFoundException('Player not found');
      }

      if (await this.areFriends(tx, requesterId, targetId)) {
        throw new ConflictException('You are already friends with this player');
      }

      const open = await tx.friendRequest.findUnique({
        where: { pendingPairKey: pairKeyOf(requesterId, targetId) },
        include: REQUEST_INCLUDE,
      });
      if (open) {
        if (open.requesterId === requesterId) {
          throw new ConflictException(
            'You already have a pending friend request to this player',
          );
        }
        // Crossed: they already asked us. Accept theirs - one friendship.
        const accepted = await this.acceptInTx(tx, toView(open), requesterId);
        return { crossed: true as const, request: accepted };
      }

      const outgoing = await tx.friendRequest.count({
        where: { requesterId, status: 'PENDING' },
      });
      if (outgoing >= MAX_OUTGOING_PENDING_REQUESTS) {
        throw new ConflictException(
          `You have too many pending friend requests (limit ${MAX_OUTGOING_PENDING_REQUESTS})`,
        );
      }

      const created = await tx.friendRequest.create({
        data: {
          requesterId,
          addresseeId: targetId,
          pendingPairKey: pairKeyOf(requesterId, targetId),
        },
        include: REQUEST_INCLUDE,
      });
      return { crossed: false as const, request: toView(created) };
    });

    // Only after the transaction has committed.
    if (outcome.crossed) {
      this.emitter.emitToUser(
        outcome.request.requesterId,
        'friend:request-accepted',
        {
          requestId: outcome.request.id,
          friend: outcome.request.addressee,
        },
      );
    } else {
      this.emitter.emitToUser(targetId, 'friend:request-received', {
        requestId: outcome.request.id,
        from: outcome.request.requester,
      });
    }
    return outcome.request;
  }

  /** Only the addressee. Creates the friendship and tells the sender. */
  async acceptRequest(
    userId: string,
    requestId: string,
  ): Promise<FriendRequestView> {
    const request = await this.findForParticipant(userId, requestId);
    if (request.addresseeId !== userId) {
      throw new ForbiddenException('Only the recipient can accept');
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockUserPair(tx, request.requesterId, request.addresseeId);
      await lockFriendSlots(tx, request.requesterId, request.addresseeId);

      const relation = await this.blocksService.relationBetween(
        request.requesterId,
        request.addresseeId,
        tx,
      );
      if (relation.blockedByViewer || relation.blockedViewer) {
        // Only reachable if the request was created concurrently with a block
        // (a block cancels every request that already existed). Cancel it
        // rather than leave it acceptable, and commit that - throwing would
        // roll the cancellation back.
        await tx.friendRequest.updateMany({
          where: { id: requestId, status: 'PENDING' },
          data: {
            status: 'CANCELLED',
            pendingPairKey: null,
            respondedAt: new Date(),
          },
        });
        return { blocked: true as const };
      }
      return {
        blocked: false as const,
        request: await this.acceptInTx(tx, request, userId),
      };
    });

    if (outcome.blocked) {
      // Same answer as any request that is gone: accepting never reveals a block.
      throw new ConflictException(NO_LONGER_PENDING);
    }
    this.emitter.emitToUser(request.requesterId, 'friend:request-accepted', {
      requestId,
      friend: outcome.request.addressee,
    });
    return outcome.request;
  }

  /**
   * Only the addressee. A single conditional update, so it needs no pair lock:
   * it holds one row and asks for nothing else, so it cannot take part in a
   * lock cycle, and a racing accept/block simply finds it no longer PENDING.
   */
  async declineRequest(
    userId: string,
    requestId: string,
  ): Promise<FriendRequestView> {
    const request = await this.findForParticipant(userId, requestId);
    if (request.addresseeId !== userId) {
      throw new ForbiddenException('Only the recipient can decline');
    }
    return this.resolveWithoutFriendship(request, 'DECLINED');
  }

  /** Only the sender, while still pending. Same locking reasoning as decline. */
  async cancelRequest(
    userId: string,
    requestId: string,
  ): Promise<FriendRequestView> {
    const request = await this.findForParticipant(userId, requestId);
    if (request.requesterId !== userId) {
      throw new ForbiddenException('Only the sender can cancel');
    }
    return this.resolveWithoutFriendship(request, 'CANCELLED');
  }

  /** Removes a friendship. Does not block, and nothing recreates it. */
  async removeFriend(userId: string, friendId: string): Promise<void> {
    if (userId === friendId) {
      throw new BadRequestException('You cannot remove yourself');
    }
    const { low, high } = orderPair(userId, friendId);
    const removed = await this.prisma.$transaction(async (tx) => {
      await lockUserPair(tx, userId, friendId);
      return tx.friendship.deleteMany({
        where: { userLowId: low, userHighId: high },
      });
    });
    if (removed.count === 0) {
      throw new NotFoundException('Friend not found');
    }
  }

  /** The viewer's pending requests, newest first. Never shows hidden players. */
  async listRequests(
    viewerId: string,
    direction: FriendRequestDirection,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<FriendRequestView>> {
    const requests = await this.prisma.friendRequest.findMany({
      where:
        direction === 'incoming'
          ? { addresseeId: viewerId, status: 'PENDING' }
          : { requesterId: viewerId, status: 'PENDING' },
      include: REQUEST_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = requests.length > limit;
    const page = hasMore ? requests.slice(0, limit) : requests;

    const otherOf = (r: (typeof page)[number]) =>
      direction === 'incoming' ? r.requester : r.addressee;
    const relations = await this.blocksService.relationsBetween(
      viewerId,
      page.map((r) => otherOf(r).id),
    );
    const items = page
      .filter((r) => {
        const other = otherOf(r);
        const relation = relations.get(other.id);
        return (
          other.status === 'ACTIVE' &&
          relation !== undefined &&
          !isHiddenFromSummaries(relation)
        );
      })
      .map(toView);

    return { items, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  /**
   * The viewer's friends with their presence. Presence comes from ONE Redis
   * `MGET` for exactly the friends returned - never one call per friend, never
   * from a client-supplied list - and falls back to OFFLINE if Redis is down.
   * A friendship row that is stale (a block now exists between the pair, or
   * the friend is no longer ACTIVE) is left out entirely, and presence is never
   * even requested for that player.
   */
  async listFriends(
    viewerId: string,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<FriendView>> {
    const rows = await this.prisma.friendship.findMany({
      where: { OR: [{ userLowId: viewerId }, { userHighId: viewerId }] },
      include: {
        low: { select: SUMMARY_WITH_STATUS_SELECT },
        high: { select: SUMMARY_WITH_STATUS_SELECT },
      },
      orderBy: [
        { createdAt: 'desc' },
        { userLowId: 'desc' },
        { userHighId: 'desc' },
      ],
      take: limit + 1,
      ...(cursor
        ? {
            cursor: {
              userLowId_userHighId: {
                userLowId: orderPair(viewerId, cursor).low,
                userHighId: orderPair(viewerId, cursor).high,
              },
            },
            skip: 1,
          }
        : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const friends = page.map((row) => ({
      friend: row.userLowId === viewerId ? row.high : row.low,
      since: row.createdAt,
    }));

    const relations = await this.blocksService.relationsBetween(
      viewerId,
      friends.map((f) => f.friend.id),
    );
    const visible = friends.filter((f) => {
      const relation = relations.get(f.friend.id);
      return (
        f.friend.status === 'ACTIVE' &&
        relation !== undefined &&
        !isHiddenFromSummaries(relation)
      );
    });

    const presence = await this.presenceFor(visible.map((f) => f.friend.id));
    const items: FriendView[] = visible.map((f) => ({
      friend: summaryOf(f.friend),
      presence: presence.get(f.friend.id) ?? 'OFFLINE',
      friendsSince: f.since,
    }));

    return {
      items,
      nextCursor: hasMore ? friends[friends.length - 1].friend.id : null,
    };
  }

  /** Best-effort: any Redis failure means everyone is OFFLINE, not an error. */
  private async presenceFor(
    friendIds: string[],
  ): Promise<Map<string, FriendPresence>> {
    const result = new Map<string, FriendPresence>();
    if (friendIds.length === 0) return result;
    try {
      const found = await this.presenceService.getMany(friendIds);
      for (const [id, status] of found) result.set(id, status ?? 'OFFLINE');
    } catch (error) {
      this.logger.warn(
        `Presence lookup failed, reporting friends OFFLINE: ${String(error)}`,
      );
    }
    return result;
  }

  private async resolveWithoutFriendship(
    request: FriendRequestView,
    status: 'DECLINED' | 'CANCELLED',
  ): Promise<FriendRequestView> {
    const { count } = await this.prisma.friendRequest.updateMany({
      where: { id: request.id, status: 'PENDING' },
      data: { status, pendingPairKey: null, respondedAt: new Date() },
    });
    if (count === 0) {
      throw new ConflictException(NO_LONGER_PENDING);
    }
    const updated = await this.prisma.friendRequest.findUniqueOrThrow({
      where: { id: request.id },
      include: REQUEST_INCLUDE,
    });
    return toView(updated);
  }

  /**
   * Claims a PENDING request and creates the friendship, in the caller's
   * transaction, which must already hold the pair lock and both friend slots.
   * Both players must be under the friend limit; if not, the whole transaction
   * (including the claim) rolls back and the request stays PENDING.
   */
  private async acceptInTx(
    tx: Prisma.TransactionClient,
    request: FriendRequestView,
    acceptorId: string,
  ): Promise<FriendRequestView> {
    const otherId =
      request.requesterId === acceptorId
        ? request.addresseeId
        : request.requesterId;
    if ((await this.countFriends(tx, acceptorId)) >= MAX_FRIENDS) {
      throw new ConflictException(
        `Your friend list is full (limit ${MAX_FRIENDS})`,
      );
    }
    if ((await this.countFriends(tx, otherId)) >= MAX_FRIENDS) {
      // Deliberately vague: this must not reveal the other player's list size.
      throw new ConflictException('This friend request cannot be accepted');
    }

    const respondedAt = new Date();
    const { count } = await tx.friendRequest.updateMany({
      where: { id: request.id, status: 'PENDING' },
      data: { status: 'ACCEPTED', pendingPairKey: null, respondedAt },
    });
    if (count === 0) {
      throw new ConflictException(NO_LONGER_PENDING);
    }

    const { low, high } = orderPair(request.requesterId, request.addresseeId);
    await tx.friendship.createMany({
      data: [{ userLowId: low, userHighId: high }],
      skipDuplicates: true,
    });
    return {
      ...request,
      status: 'ACCEPTED',
      pendingPairKey: null,
      respondedAt,
    };
  }

  private countFriends(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<number> {
    return tx.friendship.count({
      where: { OR: [{ userLowId: userId }, { userHighId: userId }] },
    });
  }

  private async areFriends(
    tx: Prisma.TransactionClient,
    userIdA: string,
    userIdB: string,
  ): Promise<boolean> {
    const { low, high } = orderPair(userIdA, userIdB);
    const row = await tx.friendship.findUnique({
      where: { userLowId_userHighId: { userLowId: low, userHighId: high } },
      select: { userLowId: true },
    });
    return row !== null;
  }

  /** 404s for anyone who is not the sender or the recipient - IDOR-safe. */
  private async findForParticipant(
    userId: string,
    requestId: string,
  ): Promise<FriendRequestView> {
    const request = await this.prisma.friendRequest.findUnique({
      where: { id: requestId },
      include: REQUEST_INCLUDE,
    });
    if (
      !request ||
      (request.requesterId !== userId && request.addresseeId !== userId)
    ) {
      throw new NotFoundException('Friend request not found');
    }
    return toView(request);
  }
}
