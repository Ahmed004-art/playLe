/**
 * Mirrors the API's `MatchResponseDto` (src/matches/dto/match-response.dto.ts).
 * Read-only visibility — there is deliberately no "set winner" override of
 * any kind in this admin app; outcomes are server-decided only (ADR-008).
 */
export interface AdminMatchPlayer {
  userId: string;
  seat: number;
  connected: boolean;
}

export interface AdminMatch {
  id: string;
  gameId: string;
  gameVersion: number;
  status: string;
  stateVersion: number;
  state: unknown;
  winnerUserId: string | null;
  resultIsDraw: boolean;
  terminationReason: string | null;
  players: AdminMatchPlayer[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * Mirrors the API's `MatchStakeResponseDto` / `SettlementResponseDto`
 * (Phase 5 — see docs/decisions/ADR-016-match-financial-architecture.md
 * and ADR-017-deterministic-settlement.md). Both `stake` and
 * `settlement` are `null` for a free-play match. Read-only — there is no
 * admin action anywhere that sets a winner, credits/debits a wallet
 * directly, or otherwise bypasses settlement.
 */
export type MatchStakeStatus =
  | 'PENDING'
  | 'HELD'
  | 'ACTIVE'
  | 'SETTLING'
  | 'SETTLED'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'DISPUTED'
  | 'FAILED';

export interface MatchStakePlayer {
  userId: string;
  heldAt: string | null;
}

export interface AdminMatchStake {
  id: string;
  status: MatchStakeStatus;
  currency: string;
  stakeAmountMinor: string;
  poolAmountMinor: string;
  players: MatchStakePlayer[];
}

export type SettlementOutcome = 'WIN' | 'DRAW' | 'REFUND' | 'CANCELLED';
export type SettlementStatus = 'PENDING' | 'COMPLETED' | 'FAILED';
export type SettlementEntryRole =
  'WINNER' | 'LOSER' | 'DRAW_PARTICIPANT' | 'REFUND_RECIPIENT' | 'PLATFORM_FEE';

export interface SettlementEntry {
  userId: string;
  role: SettlementEntryRole;
  availableDeltaMinor: string;
  heldDeltaMinor: string;
}

export interface AdminSettlement {
  id: string;
  outcome: SettlementOutcome;
  status: SettlementStatus;
  currency: string;
  poolAmountMinor: string;
  platformFeeAmountMinor: string;
  entries: SettlementEntry[];
  completedAt: string | null;
}

export interface AdminMatchFinancial {
  stake: AdminMatchStake | null;
  settlement: AdminSettlement | null;
}
