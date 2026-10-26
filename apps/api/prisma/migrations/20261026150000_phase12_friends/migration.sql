-- CreateEnum
CREATE TYPE "FriendRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- CreateTable
CREATE TABLE "friend_requests" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "addresseeId" TEXT NOT NULL,
    "status" "FriendRequestStatus" NOT NULL DEFAULT 'PENDING',
    "pendingPairKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "friend_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "friendships" (
    "userLowId" TEXT NOT NULL,
    "userHighId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friendships_pkey" PRIMARY KEY ("userLowId","userHighId")
);

-- CreateIndex
CREATE UNIQUE INDEX "friend_requests_pendingPairKey_key" ON "friend_requests"("pendingPairKey");

-- CreateIndex
CREATE INDEX "friend_requests_requesterId_status_idx" ON "friend_requests"("requesterId", "status");

-- CreateIndex
CREATE INDEX "friend_requests_addresseeId_status_idx" ON "friend_requests"("addresseeId", "status");

-- CreateIndex
CREATE INDEX "friendships_userHighId_idx" ON "friendships"("userHighId");

-- AddForeignKey
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_userLowId_fkey" FOREIGN KEY ("userLowId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_userHighId_fkey" FOREIGN KEY ("userHighId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The constraints below are hand-written: Prisma cannot declare check
-- constraints, so they are not in schema.prisma (ADR-026). The "C" collation
-- makes every ordering here byte-wise, the same as a JavaScript string sort, so
-- the database and the application always agree on which id of a pair is "low".

-- A player cannot send a friend request to themselves.
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_no_self_request" CHECK ("requesterId" <> "addresseeId");

-- pendingPairKey is set exactly while the request is PENDING, so the unique
-- index on it means "at most one open request per unordered pair" and a
-- resolved request can never block a new one.
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_pending_key_matches_status" CHECK (("status" = 'PENDING') = ("pendingPairKey" IS NOT NULL));

-- ... and it is always the sorted "lowId:highId" of the two users, so
-- A -> B and B -> A collide on the same key.
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_pending_key_is_sorted_pair" CHECK (
    "pendingPairKey" IS NULL
    OR "pendingPairKey" = CASE
        WHEN "requesterId" COLLATE "C" < "addresseeId" COLLATE "C" THEN "requesterId" || ':' || "addresseeId"
        ELSE "addresseeId" || ':' || "requesterId"
    END
);

-- A friendship is stored once per unordered pair, canonically low < high. This
-- also forbids a self-friendship.
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_canonical_order" CHECK ("userLowId" COLLATE "C" < "userHighId" COLLATE "C");
