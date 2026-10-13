/**
 * Mirrors `apps/api/src/eligibility/dto/responsible-gaming.dto.ts` and
 * the `ResponsibleGamingRestriction` Prisma model (Phase 8 — see
 * docs/decisions/ADR-023-rolling-window-responsible-gaming.md). Amounts
 * inside `config` are decimal minor-unit strings, never a number.
 */
export interface AdminResponsibleGamingRestriction {
  id: string;
  userId: string;
  type: string;
  status: string;
  config: Record<string, unknown>;
  startsAt: string;
  endsAt: string | null;
  liftedAt: string | null;
  liftedReason: string | null;
  createdAt: string;
}

/**
 * The same rolling-window figures `EligibilityService` actually
 * enforces against — not a separate, potentially-stale computation.
 */
export interface AdminResponsibleGamingUsage {
  windowHours: number;
  stakeHeldMinor: string;
  lossMinor: string;
  depositedMinor: string;
}
