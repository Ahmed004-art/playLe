/**
 * Mirrors the API's reconciliation report shape (Phase 5 — see
 * docs/decisions/ADR-018-financial-state-machines.md). Running
 * reconciliation is entirely read-only: `GET /admin/reconciliation/run`
 * never modifies any record, it only reports anomalies for an admin to
 * investigate.
 */
export type ReconciliationAnomalyType =
  | 'ORPHANED_HOLD'
  | 'MISSING_SETTLEMENT'
  | 'DUPLICATE_SETTLEMENT'
  | 'UNBALANCED_SETTLEMENT'
  | 'WALLET_LEDGER_MISMATCH';

export interface ReconciliationAnomaly {
  type: ReconciliationAnomalyType;
  matchId?: string;
  matchStakeId?: string;
  settlementId?: string;
  walletId?: string;
  detail: string;
}

export interface ReconciliationReport {
  generatedAt: string;
  anomalies: ReconciliationAnomaly[];
}
