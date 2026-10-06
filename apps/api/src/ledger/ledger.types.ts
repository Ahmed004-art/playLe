import type { LedgerEntryType } from '@prisma/client';

/**
 * Input to `LedgerService.applyEntry`. One call = one atomic,
 * balance-affecting business event. Both deltas may be non-zero in the
 * same call (e.g. a HOLD moves money from available to held at once).
 */
export interface ApplyLedgerEntryParams {
  type: LedgerEntryType;
  availableDeltaMinor: bigint;
  heldDeltaMinor: bigint;
  currency?: string;
  /** Required by `applyEntry` when `type` is `ADJUSTMENT`. */
  reason?: string;
  relatedDepositId?: string;
  relatedWithdrawalId?: string;
  relatedMatchStakeId?: string;
  providerReference?: string;
  /** The admin who authorized the entry. Only meaningful for `ADJUSTMENT`. */
  createdByAdminId?: string;
}
