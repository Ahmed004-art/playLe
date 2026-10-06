/**
 * The seeded platform/system account (see
 * docs/decisions/ADR-016-match-financial-architecture.md). A real `User`
 * row (`role: SYSTEM`, `status: DISABLED`) with its own `Wallet`, so every
 * existing `LedgerService`/`WalletService` code path works unmodified.
 * Never a normal player: `DISABLED` status already blocks login
 * (`JwtAuthGuard`) and challenge-opponent selection (`ChallengesService`
 * requires `status: 'ACTIVE'`).
 */
export const SYSTEM_ACCOUNT_USER_ID = 'system-platform-account';
