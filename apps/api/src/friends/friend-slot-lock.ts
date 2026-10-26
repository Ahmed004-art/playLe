import type { Prisma } from '@prisma/client';

/**
 * Namespace for the per-user "friend slot" advisory lock. Two-int form, so it
 * is a different key space from both `createMatchGuarded`'s single-bigint
 * per-user lock and the pair lock (namespace 1201).
 */
const FRIEND_SLOT_LOCK_NAMESPACE = 1202;

/**
 * Serialises the transactions that read a player's friend count or pending
 * outgoing-request count and then write (Phase 12 PR 3 - ADR-026).
 *
 * The pair lock alone cannot do this: two different pairs that share a player
 * (A accepting B and A accepting C at the same time) hold different pair locks,
 * so both could see 199 friends and both add one. Locking each player's slot
 * makes the second transaction wait, then see 200.
 *
 * **Lock order:** always take the pair lock (`lockUserPair`) first, then this,
 * with the ids sorted - so two transactions sharing a player always contend on
 * that player's slot in the same order and can never wait on each other in a
 * cycle. Nothing takes a slot lock and then a pair lock.
 */
export async function lockFriendSlots(
  tx: Prisma.TransactionClient,
  ...userIds: string[]
): Promise<void> {
  const sorted = [...new Set(userIds)].sort();
  for (const userId of sorted) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FRIEND_SLOT_LOCK_NAMESPACE}::int, hashtext(${userId}))`;
  }
}
