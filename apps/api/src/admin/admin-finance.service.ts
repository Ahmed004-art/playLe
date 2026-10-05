import { Injectable } from '@nestjs/common';
import type { Wallet } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { parseAmountMinor } from '../common/money.js';

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
    });
  }
}
