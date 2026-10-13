# Database

## Stack

- **PostgreSQL** — system of record for all persistent data
  ([ADR-003](../decisions/ADR-003-database.md)).
- **Prisma** — ORM, schema definition, and migration tool
  ([ADR-004](../decisions/ADR-004-prisma.md)).

Schema lives at `apps/api/prisma/schema.prisma`. Migrations live at
`apps/api/prisma/migrations/`.

## Current Schema

### Identity (Phase 2 — see [ADR-011](../decisions/ADR-011-authentication.md))

- **`User`** — the account record: `email` (unique), `phoneNumber`
  (unique, optional), `username` (unique), `passwordHash`, `role`
  (`USER`/`ADMIN`), `status` (`ACTIVE`/`SUSPENDED`/`DISABLED`),
  `dateOfBirth`, `emailVerifiedAt`/`phoneVerifiedAt` (schema placeholders
  since Phase 2; now actually set by Phase 6's `VerificationService` —
  see below), `lastLoginAt`, `createdAt`/`updatedAt`.
  `passwordHash` must never be serialized into an API response — see
  `UsersService.toSafeUser()`.
- **`RefreshToken`** — session state supporting rotation and reuse
  detection: `tokenHash` (SHA-256 of the raw token — the raw token itself
  is never persisted), `familyId`, `revokedAt`, `replacedByHash`,
  `expiresAt`, plus `userAgent`/`ipAddress` for future session-management
  UI. Cascade-deletes with its `User`.

### Financial (Phase 3 — see [ADR-012](../decisions/ADR-012-financial-architecture.md))

All monetary fields are `BigInt` (minor units; 1 SLE = 100 minor units) —
never a float. Financial relations to `User` use `onDelete: Restrict`
(not cascade) — financial history blocks user deletion by design.

- **`Wallet`** — one per `User` (`userId` unique). `availableBalanceMinor`,
  `heldBalanceMinor`, `currency`. CHECK constraints (hand-added to the
  migration) enforce both `>= 0` at the database layer, below the
  application-level checks in `LedgerService`.
- **`LedgerEntry`** — immutable, append-only. `type` (`DEPOSIT`,
  `WITHDRAWAL`, `HOLD`, `RELEASE`, `REFUND`, `ADJUSTMENT`, plus
  reserved-but-unused `PRIZE`/`PLATFORM_FEE` for a future betting phase),
  signed `availableDeltaMinor`/`heldDeltaMinor`, `*BalanceAfterMinor`
  snapshots, optional `relatedDepositId`/`relatedWithdrawalId`/
  `providerReference`/`createdByAdminId`. Only `LedgerService.applyEntry`
  ever writes this table.
- **`Deposit`** — `amountMinor`, `status` (`PENDING`/`COMPLETED`/
  `FAILED`/`CANCELLED`), `provider`, `providerReference`,
  `idempotencyKey` (`@@unique([userId, idempotencyKey])` — this
  constraint *is* the client-retry idempotency mechanism).
- **`Withdrawal`** — `amountMinor`, `status` (`PENDING_REVIEW`/
  `APPROVED`/`REJECTED`/`COMPLETED`/`FAILED`/`CANCELLED`),
  `destinationDetails` (JSON, abstracted/unverified — no KYC yet),
  `idempotencyKey`, admin review fields (`reviewedByAdminId`,
  `reviewReason`).
- **`ProviderEvent`** — raw inbound webhook audit/idempotency record,
  `@@unique([provider, providerEventId])` — the webhook-retry idempotency
  mechanism and the audit trail of every delivery attempt.

Phase 1's `schema.prisma` intentionally contained no business models;
connectivity was proven via a raw `SELECT 1` instead. That raw query is
still what the health check uses.

### Game Platform (Phase 4 — see [ADR-015](../decisions/ADR-015-game-module-architecture.md))

No financial relation here uses `onDelete: Restrict` — match participation
isn't financial history, so these cascade/null out normally.

- **`Game`** — the catalog. `id` (slug, e.g. `"tic_tac_toe"`),
  `displayName`, `description`, `minPlayers`, `maxPlayers`, `enabled`,
  `version`, `iconKey`. Seeded with exactly one row (hand-added `INSERT`
  in the migration, the same pattern Phase 3 used for hand-added `CHECK`
  constraints).
- **`Match`** — `gameId` (FK → `Game`), `gameVersion` (snapshot at
  creation), `status` (`MatchStatus`: `WAITING, READY, ACTIVE, COMPLETED,
  CANCELLED, EXPIRED, ABANDONED`), `stateVersion` (incremented on every
  accepted command), `state` (`Json`, opaque to the platform — only the
  owning `GameModule` interprets it), `winnerUserId` (FK → `User`,
  `onDelete: SetNull`), `resultIsDraw`, `terminationReason`
  (`MatchTerminationReason`, nullable), `createdAt`/`readyAt`/
  `startedAt`/`completedAt`/`expiresAt`.
- **`MatchPlayer`** — `matchId` (FK → `Match`, Cascade), `userId` (FK →
  `User`, Cascade), `seat` (stable 0-based index — the game module
  decides what each seat means), `disconnectedAt`/`leftAt`.
  `@@unique([matchId, userId])`, `@@unique([matchId, seat])`.
- **`MatchCommand`** — the idempotency + audit record for a submitted
  command. **`id` is client-supplied** (composite PK
  `@@id([matchId, id])` — the id itself is the dedup key, not a separate
  idempotency-key column). `userId`, `type` (currently always `"MOVE"`),
  `payload` (`Json`), `resultStatus` (`"ACCEPTED"`/`"REJECTED"`),
  `rejectionReason`, `stateVersionAfter`, `createdAt`.
- **`Challenge`** — `gameId` (FK → `Game`), `challengerId`/`opponentId`
  (FK → `User`, named relations, Cascade), `status` (`ChallengeStatus`:
  `PENDING, ACCEPTED, DECLINED, EXPIRED, CANCELLED`), `matchId`
  (nullable, FK → `Match`, `onDelete: SetNull`, set once accepted),
  `expiresAt`, `createdAt`, `respondedAt`.

### Match Financial Engine (Phase 5 — see [ADR-016](../decisions/ADR-016-match-financial-architecture.md)/[ADR-017](../decisions/ADR-017-deterministic-settlement.md))

- **`MatchStake`** — the hold-commitment record, 1:1 with `Match`
  (`matchId` unique, `onDelete: Restrict` — financial history).
  `stakeAmountMinor` is one value shared by every player (equal-stake
  enforced by construction, not validation). `status`
  (`MatchStakeStatus`: `PENDING, HELD, ACTIVE, SETTLING, SETTLED,
  REFUNDED, CANCELLED, DISPUTED, FAILED` — `HELD`/`DISPUTED` reserved,
  not currently reachable; see ADR-018).
- **`MatchStakePlayer`** — one row per participant's hold state
  (`heldAt`). `@@unique([matchStakeId, userId])`.
- **`Settlement`** — the one terminal financial outcome, 1:1 with
  `MatchStake`. **`@@unique` on `matchStakeId` is the exactly-once
  guarantee** — a second settlement attempt always hits this constraint.
  `outcome` (`WIN`/`DRAW`/`REFUND`/`CANCELLED`), `poolAmountMinor`/
  `platformFeeAmountMinor` captured as an immutable snapshot at
  settlement time.
- **`SettlementEntry`** — one row per money movement a settlement
  causes (`role`: `WINNER`/`LOSER`/`DRAW_PARTICIPANT`/
  `REFUND_RECIPIENT`/`PLATFORM_FEE`), with a direct `@@unique`
  `ledgerEntryId` pointer to the exact `LedgerEntry` that carried it out
  — the complete audit trail.
- **`Dispute`** — a player's dispute of a completed/abandoned match's
  outcome. Status/audit only; `DisputesService` has no code path that
  touches a `Wallet`. `matchId`/`raisedByUserId` both `onDelete:
  Restrict`.
- **New `LedgerEntryType` values**: `STAKE_HOLD`, `STAKE_REFUND`,
  `STAKE_LOSS`. `PRIZE`/`PLATFORM_FEE` (reserved since Phase 3) are
  produced for the first time. `LedgerEntry.relatedMatchStakeId` added
  for traceability.
- **The platform/system account**: a real `User` row (new
  `UserRole.SYSTEM`, `status: DISABLED`) with its own `Wallet`, seeded
  by migration — see ADR-016 for why this reuses `User`/`Wallet` rather
  than a new nullable-owner schema.
- **`Challenge`** gained optional `stakeAmountMinor`/`stakeCurrency` —
  immutable once set; `null` means ordinary free play.

### Production Payments, Account Security & Responsible Gaming (Phase 6 — see [ADR-019](../decisions/ADR-019-production-payments.md)/[ADR-020](../decisions/ADR-020-account-security.md)/[ADR-021](../decisions/ADR-021-eligibility-and-responsible-gaming.md))

- **`ProviderOperation`** — one row per outbound provider call
  (deposit-initiation or payout), keyed by a unique
  `providerIdempotencyKey` so a retry of the same PlayLe-side attempt
  reuses it rather than minting a new one. `kind`
  (`ProviderOperationKind`), `status` (`ProviderOperationStatus`,
  includes `UNKNOWN` for a network error whose real-world outcome is
  genuinely unverifiable), optional `relatedDepositId`/
  `relatedWithdrawalId`, `requestSnapshot`/`responseSnapshot` (`Json`).
- **`PaymentReconciliationAnomaly`** — a finding recorded by
  `PaymentReconciliationService` (never a mutation): `type`
  (`PaymentAnomalyType`), `status` (`PaymentAnomalyStatus`, default
  `OPEN`), optional `relatedDepositId`/`relatedWithdrawalId`, `details`
  (`Json`), admin resolution fields (`resolvedByAdminId`,
  `resolutionNote`). Deduplicated against already-`OPEN` rows across
  repeated reconciliation runs.
- **`PasswordResetToken`** — mirrors `RefreshToken`'s pattern: only
  `tokenHash` (SHA-256) is persisted, never the raw token.
  `expiresAt`/`usedAt` (single-use), `requestIp`. Cascade-deletes with
  its `User`.
- **`VerificationChallenge`** — an email/phone verification code
  challenge: `channel` (`VerificationChannel`), `purpose`
  (`VerificationPurpose`), `target`, `codeHash` (never the raw code),
  `attempts` (5-attempt throttle), `expiresAt`, `consumedAt`.
- **`MfaTotpCredential`** — one per `User` (`userId` unique).
  `secretEncrypted` (AES-256-GCM, never plaintext), `confirmedAt`
  (enrollment enforces nothing until this is set), `disabledAt`. Has
  many `MfaRecoveryCode`.
- **`MfaRecoveryCode`** — a single-use recovery code for an
  `MfaTotpCredential`: `codeHash` (never the raw code), `usedAt`.
- **`ResponsibleGamingRestriction`** — never destructively edited; a
  change is always a new row, so full history is reconstructable.
  `type` (`ResponsibleGamingRestrictionType`: includes
  `SELF_EXCLUSION`, which has no lift method anywhere in the codebase),
  `status` (`ResponsibleGamingRestrictionStatus`), `config` (`Json`,
  type-specific, e.g. `{"limitMinor": "50000"}` for a
  `DEPOSIT_LIMIT`/`STAKE_LIMIT`/`LOSS_LIMIT`), `startsAt`/`endsAt`/
  `liftedAt`. `userId` uses
  `onDelete: Restrict` — financial/compliance history.
- **`NotificationOutbox`** — a financial/security notification queued
  in the *same* transaction as its triggering ledger write, delivered
  later by a separate sweep. `type` (`NotificationType`), `payload`
  (`Json`), `status` (`NotificationOutboxStatus`, default `PENDING`),
  `attempts` (5-attempt cap), `failureReason`, `sentAt`. Delivery
  failure never rolls back or retries the financial operation that
  produced the row.
- **`AdminAuditLog`** — append-only record of admin-session/security
  events (`AdminAuditAction`: `LOGIN_SUCCESS`, `LOGIN_FAILED`, `LOGOUT`,
  `SESSION_REFRESH`, `CSRF_REJECTED`, `MFA_ENROLLED`, `MFA_DISABLED`,
  `MFA_CHALLENGE_FAILED`, `PASSWORD_RESET_REQUESTED`,
  `PASSWORD_RESET_COMPLETED`). `adminId` (`onDelete: SetNull`),
  `detail`, `ipAddress`, `userAgent`.
- **Extended enums**: `DepositStatus` gained `EXPIRED` (a provider-side
  payment code/session expired before the user paid — real-provider
  deposits only, a `MANUAL` deposit never reaches this state);
  `WithdrawalStatus` gained `PROCESSING` (submitted to the payout
  provider, outcome not yet confirmed — funds stay held; nothing is
  released or re-submitted automatically from this state).
- **Two migrations**: `20261012000324_phase6_payments_security_schema`
  (all of the models/enums above except `AdminAuditLog`) and a later,
  separate `20261012005049_phase6_admin_audit_log` (adds only the
  `AdminAuditAction` enum and the `admin_audit_logs` table — the audit
  log was introduced as a follow-on to the rest of the Phase 6 schema,
  not part of the original migration).

## Phase 8 — Rolling-Window Responsible-Gaming Enforcement

No new models. Rolling-window enforcement (see
[ADR-023](../decisions/ADR-023-rolling-window-responsible-gaming.md))
reads the existing `LedgerEntry`/`SettlementEntry` tables directly —
only indexes and one notification enum value were added:

- `LedgerEntry` gained `@@index([userId, type, createdAt])` — the exact
  shape of the `STAKE_HOLD`/`DEPOSIT` rolling-sum queries
  `EligibilityService` now runs.
- `SettlementEntry` gained `@@index([userId, role, createdAt])` — the
  exact shape of the `LOSER`-role rolling-loss-sum query.
- `NotificationType` gained `RESPONSIBLE_GAMING_LIMIT_REACHED`.
- **Two migrations, for the enum-value reason explained under
  "Migration Discipline" below**: `20261013020835_add_responsible_gaming_rolling_window_indexes`
  (the two indexes) and
  `20261013020931_add_responsible_gaming_limit_reached_notification`
  (the enum value, added separately so a later migration or seed could
  safely use it — not strictly required here since nothing inserts a
  row using the new value in the same migration, but kept as two
  migrations for consistency with that rule and because the indexes and
  the notification type are unrelated changes).

## Phase Scope

Phase 2 established identity/session data. Phase 3 added the financial
foundation above. Phase 4 added the game platform above. Phase 5 added
the match financial engine above, connecting the two. Phase 6 added
production-payment provider tracking/reconciliation, account-security
(password reset, verification, MFA, admin audit log), and
responsible-gaming/notification-outbox models above. **Phase 7 added no
new models or columns** — Checkers reuses the existing generic `Game`/
`Match`/`MatchPlayer`/`MatchCommand` tables exactly as Tic-Tac-Toe does
(its state lives in the same opaque `Match.state` JSON column); the
only database change is one seed migration,
`20261012220000_seed_checkers_game`, inserting the `checkers` row into
`games` (same hand-written-INSERT pattern as the original `tic_tac_toe`
seed in `20261005102538_add_game_platform_core`). Phase 8 added two
indexes and one notification enum value — no new models — see "Phase 8"
above. Social-graph tables are still designed in their own dedicated
future phase.

## Local Development Database

Provided by Docker Compose (`infrastructure/docker/docker-compose.yml`).
See `docs/development/SETUP.md` for exact commands.

- Host: `localhost`
- Port: `5432` (configurable via `.env`)
- Database: `playle_dev`
- Credentials: see `apps/api/.env.example` (local-development-only values)

## Test Database Strategy

Integration tests that need a real database point `DATABASE_URL` at a
separate database (`playle_test`) rather than the development database, so
test runs never pollute local dev data. In CI, a PostgreSQL service
container provides this. Locally, create it once:

```bash
# with the dev Postgres container running
docker exec -it playle-postgres createdb -U playle playle_test
```

Tests that don't need real persistence should not spin up the database at
all (pure unit tests). Only integration/e2e tests use the test database.

## Common Commands

Run from the repo root (delegates to `apps/api`) or from `apps/api`
directly:

```bash
npm run db:generate          # regenerate the Prisma client after a schema change
npm run db:migrate           # create + apply a dev migration
npm run db:migrate:deploy    # apply existing migrations (CI/staging/prod)
npm run db:studio            # open Prisma Studio
```

## Migration Discipline

- Every schema change goes through `prisma migrate dev` so it produces a
  reviewable migration file — never hand-edit the database out-of-band in
  a way Prisma doesn't know about.
- `prisma migrate dev` needs `CREATEDB` privilege (it creates a temporary
  shadow database to diff against) — the application's runtime database
  role should **not** have this privilege (least-privilege), so authoring
  a migration typically happens under a more-privileged role, then the
  resulting migration file is applied with `prisma migrate deploy` (which
  needs no shadow database) under the normal runtime role. This is
  standard practice, not a Phase 2-specific workaround.
- Migrations are committed to version control and applied via
  `prisma migrate deploy` in CI/staging/production, never
  `prisma db push` outside of local prototyping.
- Financial-related schema changes require particular care: additive,
  backward-compatible changes are preferred over destructive ones once
  real data exists.
- **A migration that adds a new enum value and a migration that uses
  that value must be two separate migrations.** PostgreSQL refuses
  (`unsafe use of new value ... New enum values must be committed before
  they can be used`) if a single migration's transaction both runs
  `ALTER TYPE ... ADD VALUE` and inserts a row using that same new
  value — found for real locally (Phase 5's `UserRole.SYSTEM` + the
  system-account seed row) before it ever reached CI.

## Future Schema Direction

See [ADR-009](../decisions/ADR-009-financial-ledger.md). The remaining
future schema (non-exhaustive, designed in each dedicated phase):

- Social-graph tables (follows/friends).
- A defined compliance-officer role/process and whatever schema it
  would need to lift a `SELF_EXCLUSION` restriction — not designed, and
  not expected to be added without a real legal/compliance process
  behind it (see ADR-021).

`User`, `RefreshToken`, `Wallet`, `LedgerEntry`, `Deposit`, `Withdrawal`,
`ProviderEvent` (Phase 3), `Game`, `Match`, `MatchPlayer`,
`MatchCommand`, `Challenge` (Phase 4), `MatchStake`,
`MatchStakePlayer`, `Settlement`, `SettlementEntry`, `Dispute` (Phase 5),
and `ProviderOperation`, `PaymentReconciliationAnomaly`,
`PasswordResetToken`, `VerificationChallenge`, `MfaTotpCredential`,
`MfaRecoveryCode`, `ResponsibleGamingRestriction`,
`NotificationOutbox`, `AdminAuditLog` (Phase 6) are no longer "future"
— they exist.
