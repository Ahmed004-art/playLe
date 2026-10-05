import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, Wallet } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CursorPage } from '../common/dto/pagination.dto.js';

export interface LedgerEntryWithRelations {
  id: string;
  type: string;
  availableDeltaMinor: bigint;
  heldDeltaMinor: bigint;
  availableBalanceAfterMinor: bigint;
  heldBalanceAfterMinor: bigint;
  currency: string;
  reason: string | null;
  relatedDepositId: string | null;
  relatedWithdrawalId: string | null;
  providerReference: string | null;
  createdByAdminId: string | null;
  createdAt: Date;
}

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  async getByUserId(userId: string): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }
    return wallet;
  }

  /**
   * Resolves a user's wallet id for use inside an existing transaction —
   * callers (Deposits/Withdrawals/admin adjustments) pass the result to
   * `LedgerService.applyEntry`, which does the actual row locking.
   */
  async getWalletIdForUser(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<string> {
    const wallet = await tx.wallet.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!wallet) {
      throw new NotFoundException('Wallet not found for user');
    }
    return wallet.id;
  }

  async listLedgerEntries(
    userId: string,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<LedgerEntryWithRelations>> {
    return this.listLedgerEntriesInternal({ userId }, { cursor, limit });
  }

  /** Admin visibility: optionally filtered by user, otherwise every user's ledger. */
  async listLedgerEntriesAdmin(params: {
    userId?: string;
    cursor?: string;
    limit: number;
  }): Promise<CursorPage<LedgerEntryWithRelations>> {
    const { cursor, limit, userId } = params;
    return this.listLedgerEntriesInternal(userId ? { userId } : {}, {
      cursor,
      limit,
    });
  }

  private async listLedgerEntriesInternal(
    where: Prisma.LedgerEntryWhereInput,
    { cursor, limit }: { cursor?: string; limit: number },
  ): Promise<CursorPage<LedgerEntryWithRelations>> {
    const entries = await this.prisma.ledgerEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;

    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }
}
