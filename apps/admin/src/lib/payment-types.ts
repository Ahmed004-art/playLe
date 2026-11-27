/**
 * Mirrors the API's payment-reconciliation anomaly rows
 * (`/admin/payment-reconciliation/anomalies`). Resolving one records a note;
 * it never moves money.
 */
export interface PaymentAnomaly {
  id: string;
  type: string;
  relatedDepositId: string | null;
  relatedWithdrawalId: string | null;
  details: { detail?: string; eventKey?: string } | null;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  resolutionNote: string | null;
  detectedAt: string;
  resolvedAt: string | null;
}
