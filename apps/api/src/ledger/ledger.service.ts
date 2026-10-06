import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type LedgerEntry, type Wallet } from '@prisma/client';
import type { ApplyLedgerEntryParams } from './ledger.types.js';

/**
 * The single writer of every wallet-balance change and every
 * `LedgerEntry` row. No other service in the codebase is permitted to call
 * `wallet.update(...)` or `ledgerEntry.create(...)` directly — see
 * docs/decisions/ADR-012-financial-architecture.md.
 */
@Injectable()
export class LedgerService {
  /**
   * Applies one atomic financial event: locks the wallet row (`FOR UPDATE`,
   * so concurrent mutations against the same wallet serialize instead of
   * racing), validates both resulting balances stay non-negative, updates
   * the wallet, and inserts the immutable ledger row — all within the
   * caller-supplied transaction. Throws (rolling back the whole
   * transaction) if the invariant would be violated.
   */
  /**
   * Locks the wallet row (`FOR UPDATE`) and returns it. Callers that also
   * insert a new row with a foreign key to this wallet (e.g.
   * `Withdrawal`) within the same transaction **must** call this before
   * that insert, not after: inserting first takes a shared key-lock on
   * the wallet row for FK validation, and two concurrent transactions
   * each holding that shared lock while waiting for the other's
   * `FOR UPDATE` deadlocks (seen for real under concurrent withdrawal
   * requests in CI, via a genuine Postgres `40P01` deadlock error, not
   * a flake) — locking first establishes a strict, deadlock-free lock
   * order.
   */
  async lockWallet(
    tx: Prisma.TransactionClient,
    walletId: string,
  ): Promise<Wallet> {
    const rows = await tx.$queryRaw<
      Wallet[]
    >`SELECT * FROM wallets WHERE id = ${walletId} FOR UPDATE`;
    const locked = rows[0];
    if (!locked) {
      throw new NotFoundException('Wallet not found');
    }
    return locked;
  }

  async applyEntry(
    tx: Prisma.TransactionClient,
    walletId: string,
    params: ApplyLedgerEntryParams,
  ): Promise<{ wallet: Wallet; entry: LedgerEntry }> {
    if (params.type === 'ADJUSTMENT' && !params.reason?.trim()) {
      throw new UnprocessableEntityException(
        'An ADJUSTMENT ledger entry requires a non-empty reason',
      );
    }

    const locked = await this.lockWallet(tx, walletId);

    const newAvailable =
      locked.availableBalanceMinor + params.availableDeltaMinor;
    const newHeld = locked.heldBalanceMinor + params.heldDeltaMinor;

    if (newAvailable < 0n) {
      throw new UnprocessableEntityException('Insufficient available balance');
    }
    if (newHeld < 0n) {
      throw new UnprocessableEntityException('Insufficient held balance');
    }

    const wallet = await tx.wallet.update({
      where: { id: walletId },
      data: {
        availableBalanceMinor: newAvailable,
        heldBalanceMinor: newHeld,
      },
    });

    const entry = await tx.ledgerEntry.create({
      data: {
        walletId,
        userId: locked.userId,
        type: params.type,
        availableDeltaMinor: params.availableDeltaMinor,
        heldDeltaMinor: params.heldDeltaMinor,
        availableBalanceAfterMinor: newAvailable,
        heldBalanceAfterMinor: newHeld,
        currency: params.currency ?? locked.currency,
        reason: params.reason,
        relatedDepositId: params.relatedDepositId,
        relatedWithdrawalId: params.relatedWithdrawalId,
        relatedMatchStakeId: params.relatedMatchStakeId,
        providerReference: params.providerReference,
        createdByAdminId: params.createdByAdminId,
      },
    });

    return { wallet, entry };
  }
}
