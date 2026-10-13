-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MatchTerminationReason" ADD VALUE 'RESIGNATION';
ALTER TYPE "MatchTerminationReason" ADD VALUE 'TURN_TIMEOUT';
ALTER TYPE "MatchTerminationReason" ADD VALUE 'DRAW_AGREED';

-- AlterTable
ALTER TABLE "games" ADD COLUMN     "turnTimeoutSeconds" INTEGER;

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "pendingDrawOfferByUserId" TEXT,
ADD COLUMN     "pendingDrawOfferExpiresAt" TIMESTAMP(3),
ADD COLUMN     "turnDeadlineAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "matches_status_turnDeadlineAt_idx" ON "matches"("status", "turnDeadlineAt");

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_pendingDrawOfferByUserId_fkey" FOREIGN KEY ("pendingDrawOfferByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
