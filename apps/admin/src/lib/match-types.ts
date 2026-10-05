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
