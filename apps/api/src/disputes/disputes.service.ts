import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Dispute, DisputeStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CursorPage } from '../common/dto/pagination.dto.js';

const ELIGIBLE_MATCH_STATUSES = ['COMPLETED', 'ABANDONED'] as const;
const OPEN_STATUSES = ['OPEN', 'UNDER_REVIEW'] as const;

/**
 * The technical foundation for a player disputing a completed match's
 * financial outcome (Phase 5 spec section 32). Opening or resolving a
 * dispute never itself moves money — see `ResolveDisputeDto` and
 * docs/decisions/ADR-016-match-financial-architecture.md, "compensating
 * transactions": an upheld dispute's actual correction (if any) is a
 * separate, already-audited admin wallet adjustment, performed
 * deliberately by an admin as its own action.
 */
@Injectable()
export class DisputesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    matchId: string,
    reason: string,
  ): Promise<Dispute> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { players: true },
    });
    if (!match || !match.players.some((p) => p.userId === userId)) {
      throw new NotFoundException('Match not found');
    }

    if (
      !ELIGIBLE_MATCH_STATUSES.includes(
        match.status as (typeof ELIGIBLE_MATCH_STATUSES)[number],
      )
    ) {
      throw new ConflictException(
        'Only a completed or abandoned match can be disputed',
      );
    }

    const existing = await this.prisma.dispute.findFirst({
      where: {
        matchId,
        raisedByUserId: userId,
        status: { in: [...OPEN_STATUSES] },
      },
    });
    if (existing) {
      throw new ConflictException(
        'You already have an open dispute for this match',
      );
    }

    return this.prisma.dispute.create({
      data: { matchId, raisedByUserId: userId, reason },
    });
  }

  async list(
    userId: string,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<Dispute>> {
    const disputes = await this.prisma.dispute.findMany({
      where: { raisedByUserId: userId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = disputes.length > limit;
    const items = hasMore ? disputes.slice(0, limit) : disputes;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async listAdmin(params: {
    status?: DisputeStatus;
    cursor?: string;
    limit: number;
  }): Promise<CursorPage<Dispute>> {
    const { status, cursor, limit } = params;
    const disputes = await this.prisma.dispute.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = disputes.length > limit;
    const items = hasMore ? disputes.slice(0, limit) : disputes;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async findByIdAdmin(id: string): Promise<Dispute> {
    const dispute = await this.prisma.dispute.findUnique({ where: { id } });
    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }
    return dispute;
  }

  /**
   * Status + audit only — never a balance change. `UNDER_REVIEW` is a
   * pure status update; `UPHELD`/`REFUNDED`/`RESOLVED` additionally
   * requires the dispute to not already be in a final state.
   */
  async resolve(
    adminId: string,
    disputeId: string,
    status: 'UNDER_REVIEW' | 'UPHELD' | 'REFUNDED' | 'RESOLVED',
    resolution: string,
  ): Promise<Dispute> {
    const dispute = await this.findByIdAdmin(disputeId);

    if (!OPEN_STATUSES.includes(dispute.status as 'OPEN' | 'UNDER_REVIEW')) {
      throw new ForbiddenException('This dispute is already resolved');
    }

    return this.prisma.dispute.update({
      where: { id: disputeId },
      data: {
        status,
        resolution,
        resolvedByAdminId: adminId,
        resolvedAt: status === 'UNDER_REVIEW' ? undefined : new Date(),
      },
    });
  }
}
