-- CreateEnum
CREATE TYPE "MatchStakeStatus" AS ENUM ('PENDING', 'HELD', 'ACTIVE', 'SETTLING', 'SETTLED', 'REFUNDED', 'CANCELLED', 'DISPUTED', 'FAILED');

-- CreateEnum
CREATE TYPE "SettlementOutcome" AS ENUM ('WIN', 'DRAW', 'REFUND', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SettlementEntryRole" AS ENUM ('WINNER', 'LOSER', 'DRAW_PARTICIPANT', 'REFUND_RECIPIENT', 'PLATFORM_FEE');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'UPHELD', 'REFUNDED', 'RESOLVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LedgerEntryType" ADD VALUE 'STAKE_HOLD';
ALTER TYPE "LedgerEntryType" ADD VALUE 'STAKE_REFUND';
ALTER TYPE "LedgerEntryType" ADD VALUE 'STAKE_LOSS';

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'SYSTEM';

-- AlterTable
ALTER TABLE "challenges" ADD COLUMN     "stakeAmountMinor" BIGINT,
ADD COLUMN     "stakeCurrency" TEXT;

-- AlterTable
ALTER TABLE "ledger_entries" ADD COLUMN     "relatedMatchStakeId" TEXT;

-- CreateTable
CREATE TABLE "match_stakes" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "stakeAmountMinor" BIGINT NOT NULL,
    "status" "MatchStakeStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heldAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "match_stakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_stake_players" (
    "id" TEXT NOT NULL,
    "matchStakeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "heldAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_stake_players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "matchStakeId" TEXT NOT NULL,
    "outcome" "SettlementOutcome" NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "currency" TEXT NOT NULL,
    "poolAmountMinor" BIGINT NOT NULL,
    "platformFeeAmountMinor" BIGINT NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_entries" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "SettlementEntryRole" NOT NULL,
    "availableDeltaMinor" BIGINT NOT NULL,
    "heldDeltaMinor" BIGINT NOT NULL,
    "ledgerEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "raisedByUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolvedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "match_stakes_matchId_key" ON "match_stakes"("matchId");

-- CreateIndex
CREATE INDEX "match_stakes_status_idx" ON "match_stakes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "match_stake_players_matchStakeId_userId_key" ON "match_stake_players"("matchStakeId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_matchStakeId_key" ON "settlements"("matchStakeId");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_entries_ledgerEntryId_key" ON "settlement_entries"("ledgerEntryId");

-- CreateIndex
CREATE INDEX "settlement_entries_settlementId_idx" ON "settlement_entries"("settlementId");

-- CreateIndex
CREATE INDEX "disputes_matchId_idx" ON "disputes"("matchId");

-- CreateIndex
CREATE INDEX "disputes_status_idx" ON "disputes"("status");

-- CreateIndex
CREATE INDEX "ledger_entries_relatedMatchStakeId_idx" ON "ledger_entries"("relatedMatchStakeId");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_relatedMatchStakeId_fkey" FOREIGN KEY ("relatedMatchStakeId") REFERENCES "match_stakes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_stakes" ADD CONSTRAINT "match_stakes_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_stake_players" ADD CONSTRAINT "match_stake_players_matchStakeId_fkey" FOREIGN KEY ("matchStakeId") REFERENCES "match_stakes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_stake_players" ADD CONSTRAINT "match_stake_players_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_matchStakeId_fkey" FOREIGN KEY ("matchStakeId") REFERENCES "match_stakes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_entries" ADD CONSTRAINT "settlement_entries_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_entries" ADD CONSTRAINT "settlement_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_entries" ADD CONSTRAINT "settlement_entries_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_raisedByUserId_fkey" FOREIGN KEY ("raisedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolvedByAdminId_fkey" FOREIGN KEY ("resolvedByAdminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
