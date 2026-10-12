import { Injectable } from '@nestjs/common';
import type { ProviderEvent, ProviderOperation, Wallet } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { parseAmountMinor } from '../common/money.js';
import { FINANCIAL_TRANSACTION_OPTIONS } from '../common/prisma-transaction.constants.js';
import type { CursorPage } from '../common/dto/pagination.dto.js';

@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * The single, narrow administrative balance-editing path. Always
   * reason-required, always goes through `LedgerService.applyEntry`
   * (so a DEBIT still cannot drive the balance negative), and always
   * records which admin authorized it.
   */
  async adjustWallet(
    adminId: string,
    userId: string,
    direction: 'CREDIT' | 'DEBIT',
    amountMinorStr: string,
    reason: string,
  ): Promise<Wallet> {
    const amountMinor = parseAmountMinor(amountMinorStr);
    const signedAmount = direction === 'CREDIT' ? amountMinor : -amountMinor;

    return this.prisma.$transaction(async (tx) => {
      const walletId = await this.walletService.getWalletIdForUser(tx, userId);

      const { wallet } = await this.ledgerService.applyEntry(tx, walletId, {
        type: 'ADJUSTMENT',
        availableDeltaMinor: signedAmount,
        heldDeltaMinor: 0n,
        reason,
        createdByAdminId: adminId,
      });

      return wallet;
    }, FINANCIAL_TRANSACTION_OPTIONS);
  }

  /** Read-only visibility into every outbound provider call (deposit/payout). */
  async listProviderOperations(params: {
    userId?: string;
    cursor?: string;
    limit: number;
  }): Promise<CursorPage<ProviderOperation>> {
    const { userId, cursor, limit } = params;
    const where = userId
      ? {
          OR: [{ deposit: { userId } }, { withdrawal: { userId } }],
        }
      : {};
    const rows = await this.prisma.providerOperation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /** Read-only visibility into every inbound webhook delivery (valid or not). */
  async listProviderEvents(params: {
    cursor?: string;
    limit: number;
  }): Promise<CursorPage<ProviderEvent>> {
    const { cursor, limit } = params;
    const rows = await this.prisma.providerEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }
}
