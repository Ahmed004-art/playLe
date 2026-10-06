-- Seed: the platform/system account (see docs/decisions/ADR-016-match-financial-architecture.md).
-- A real User+Wallet row reusing all existing Ledger/Wallet machinery untouched.
-- status='DISABLED' already blocks login (JwtAuthGuard) and challenge-opponent
-- selection (ChallengesService requires status='ACTIVE') with no extra checks.
-- The password hash below is a real argon2id hash of a random, discarded secret
-- (generated once at migration-authoring time) — it can never match any input,
-- but login is blocked by status before a password check would even matter.
--
-- This is a SEPARATE migration from the one that adds `UserRole.SYSTEM`
-- (20261005164913_add_match_financial_engine): PostgreSQL refuses to use a
-- brand-new enum value in the same transaction that added it
-- ("unsafe use of new value ... New enum values must be committed before
-- they can be used") — found via a real local Postgres run, not simulated.
INSERT INTO "users" ("id", "email", "phoneNumber", "username", "displayName", "passwordHash", "role", "status", "dateOfBirth", "createdAt", "updatedAt")
VALUES (
  'system-platform-account',
  'system@internal.playle',
  NULL,
  'playle_system',
  'PlayLe Platform',
  '$argon2id$v=19$m=65536,p=4,t=3$C7+3D234W+Pg43ZmwmuxkA$5qocgP+6K+kXu9NPSo6vwvc1N33IMoDAiPdxA91YWYU',
  'SYSTEM',
  'DISABLED',
  '1970-01-01T00:00:00.000Z',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "wallets" ("id", "userId", "availableBalanceMinor", "heldBalanceMinor", "currency", "createdAt", "updatedAt")
VALUES (
  'system-platform-wallet',
  'system-platform-account',
  0,
  0,
  'SLE',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
