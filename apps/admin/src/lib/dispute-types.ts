/**
 * Mirrors the API's `DisputeResponseDto` (Phase 5 — see
 * docs/decisions/ADR-018-financial-state-machines.md). Resolving a
 * dispute is status + audit only: `POST /admin/disputes/:id/resolve`
 * never moves money. There is deliberately no amount/refund field on
 * this type or anywhere in the resolve UI — any balance correction
 * after upholding a dispute is a separate call to the existing
 * `/admin/wallets/:userId/adjustments` endpoint.
 */
export type DisputeStatus = 'OPEN' | 'UNDER_REVIEW' | 'UPHELD' | 'REFUNDED' | 'RESOLVED';

export interface AdminDispute {
  id: string;
  matchId: string;
  raisedByUserId: string;
  reason: string;
  status: DisputeStatus;
  resolution: string | null;
  resolvedByAdminId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** The subset of `DisputeStatus` a resolve action may move a dispute to. */
export type DisputeResolutionStatus = 'UNDER_REVIEW' | 'UPHELD' | 'REFUNDED' | 'RESOLVED';
