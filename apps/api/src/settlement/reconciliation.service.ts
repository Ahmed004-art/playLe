import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface ReconciliationAnomaly {
  type:
    | 'ORPHANED_HOLD'
    | 'MISSING_SETTLEMENT'
    | 'DUPLICATE_SETTLEMENT'
    | 'UNBALANCED_SETTLEMENT'
    | 'WALLET_LEDGER_MISMATCH';
  matchId?: string;
  matchStakeId?: string;
  settlementId?: string;
  walletId?: string;
  detail: string;
}

export interface ReconciliationReport {
  generatedAt: Date;
  anomalies: ReconciliationAnomaly[];
}

/**
 * On-demand (admin-triggered, never scheduled) anomaly detection for the
 * match-financial engine (Phase 5 spec section 28). Every check is
 * read-only — this service never modifies a financial record; it only
 * flags what a human should look at. See
 * docs/decisions/ADR-017-deterministic-settlement.md.
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async runOnce(): Promise<ReconciliationReport> {
    const anomalies: ReconciliationAnomaly[] = [
      ...(await this.findOrphanedHolds()),
      ...(await this.findMissingSettlements()),
      ...(await this.findDuplicateSettlements()),
      ...(await this.findUnbalancedSettlements()),
      ...(await this.findWalletLedgerMismatches()),
    ];
    return { generatedAt: new Date(), anomalies };
  }

  /** A terminal match whose stake never reached SETTLED/REFUNDED. */
  private async findOrphanedHolds(): Promise<ReconciliationAnomaly[]> {
    const stuck = await this.prisma.matchStake.findMany({
      where: {
        status: { in: ['ACTIVE', 'SETTLING', 'HELD', 'FAILED'] },
        match: { status: { in: ['COMPLETED', 'ABANDONED', 'CANCELLED'] } },
      },
      select: { id: true, matchId: true, status: true },
    });
    return stuck.map((s) => ({
      type: 'ORPHANED_HOLD' as const,
      matchId: s.matchId,
      matchStakeId: s.id,
      detail: `MatchStake is ${s.status} but its match has already finished`,
    }));
  }

  /** A terminal, financially-backed match with no Settlement at all. */
  private async findMissingSettlements(): Promise<ReconciliationAnomaly[]> {
    const stakes = await this.prisma.matchStake.findMany({
      where: {
        match: { status: { in: ['COMPLETED', 'ABANDONED', 'CANCELLED'] } },
        settlement: null,
      },
      select: { id: true, matchId: true },
    });
    return stakes.map((s) => ({
      type: 'MISSING_SETTLEMENT' as const,
      matchId: s.matchId,
      matchStakeId: s.id,
      detail: 'Match finished but no Settlement row exists',
    }));
  }

  /**
   * Structurally prevented by the `@unique` constraint on
   * `Settlement.matchStakeId` — this always returns empty. Kept as a
   * real, documented check (Phase 5 spec section 28) and as defense in
   * depth should the schema ever change.
   */
  private async findDuplicateSettlements(): Promise<ReconciliationAnomaly[]> {
    const duplicates = await this.prisma.settlement.groupBy({
      by: ['matchStakeId'],
      _count: { matchStakeId: true },
      having: { matchStakeId: { _count: { gt: 1 } } },
    });
    return duplicates.map((d) => ({
      type: 'DUPLICATE_SETTLEMENT' as const,
      matchStakeId: d.matchStakeId,
      detail: `${d._count.matchStakeId} settlements exist for one match stake`,
    }));
  }

  /** Re-derives the conservation invariant from persisted rows, not just in-memory computation. */
  private async findUnbalancedSettlements(): Promise<ReconciliationAnomaly[]> {
    const settlements = await this.prisma.settlement.findMany({
      where: { status: 'COMPLETED' },
      include: { entries: true },
    });

    const anomalies: ReconciliationAnomaly[] = [];
    for (const settlement of settlements) {
      const totalHeldReleased = settlement.entries.reduce(
        (sum, e) => sum - e.heldDeltaMinor,
        0n,
      );
      const totalAvailableCredited = settlement.entries.reduce(
        (sum, e) => sum + e.availableDeltaMinor,
        0n,
      );
      if (totalHeldReleased !== totalAvailableCredited) {
        anomalies.push({
          type: 'UNBALANCED_SETTLEMENT',
          settlementId: settlement.id,
          detail: `held released (${totalHeldReleased}) != available credited (${totalAvailableCredited})`,
        });
      }
    }
    return anomalies;
  }

  /** Recomputes each wallet's balance from its own ledger history from zero. */
  private async findWalletLedgerMismatches(): Promise<ReconciliationAnomaly[]> {
    const wallets = await this.prisma.wallet.findMany({
      include: { ledgerEntries: true },
    });

    const anomalies: ReconciliationAnomaly[] = [];
    for (const wallet of wallets) {
      const expectedAvailable = wallet.ledgerEntries.reduce(
        (sum, e) => sum + e.availableDeltaMinor,
        0n,
      );
      const expectedHeld = wallet.ledgerEntries.reduce(
        (sum, e) => sum + e.heldDeltaMinor,
        0n,
      );
      if (
        expectedAvailable !== wallet.availableBalanceMinor ||
        expectedHeld !== wallet.heldBalanceMinor
      ) {
        anomalies.push({
          type: 'WALLET_LEDGER_MISMATCH',
          walletId: wallet.id,
          detail: `wallet shows available=${wallet.availableBalanceMinor} held=${wallet.heldBalanceMinor}, ledger history sums to available=${expectedAvailable} held=${expectedHeld}`,
        });
      }
    }
    return anomalies;
  }
}
