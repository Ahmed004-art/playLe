import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { SYSTEM_ACCOUNT_USER_ID } from './system-account.constants.js';

@Injectable()
export class SystemAccountService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The platform wallet's id, for use as the `walletId` argument to
   * `LedgerService.lockWallet`/`applyEntry` inside an existing
   * transaction — the exact same call shape as looking up any player's
   * wallet, so settlement code never special-cases the platform account
   * beyond knowing which user id it is.
   */
  async getWalletId(tx: Prisma.TransactionClient): Promise<string> {
    const wallet = await tx.wallet.findUniqueOrThrow({
      where: { userId: SYSTEM_ACCOUNT_USER_ID },
      select: { id: true },
    });
    return wallet.id;
  }
}
