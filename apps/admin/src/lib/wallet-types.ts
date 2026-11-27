/**
 * Mirrors the API's wallet/ledger/deposit/withdrawal response DTOs. Money
 * is always a decimal string of integer minor units (1 SLE = 100 minor
 * units) — never a number — see
 * docs/decisions/ADR-012-financial-architecture.md. This admin UI only
 * ever displays these values; it never computes with them as numbers.
 */
export interface AdminWallet {
  availableBalanceMinor: string;
  heldBalanceMinor: string;
  totalBalanceMinor: string;
  currency: string;
  updatedAt: string;
}

export interface AdminLedgerEntry {
  id: string;
  type: string;
  availableDeltaMinor: string;
  heldDeltaMinor: string;
  availableBalanceAfterMinor: string;
  heldBalanceAfterMinor: string;
  currency: string;
  reason: string | null;
  relatedDepositId: string | null;
  relatedWithdrawalId: string | null;
  providerReference: string | null;
  createdAt: string;
}

export interface AdminDeposit {
  id: string;
  amountMinor: string;
  currency: string;
  status: string;
  provider: string;
  providerReference: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminWithdrawal {
  id: string;
  amountMinor: string;
  currency: string;
  status: string;
  destinationDetails: Record<string, unknown>;
  reviewedByAdminId: string | null;
  reviewReason: string | null;
  providerReference: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * What can be done about the payout of an APPROVED/PROCESSING withdrawal:
   * NONE - no payout request was made, so it is completed or failed by hand;
   * CHECK_WITH_PROVIDER - complete/fail ask the provider and proceed only on a
   * matching answer; UNVERIFIABLE - a request is in flight or has no payout
   * reference, so neither is possible here. Absent on other statuses.
   */
  payoutCheck?: 'NONE' | 'CHECK_WITH_PROVIDER' | 'UNVERIFIABLE' | null;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
