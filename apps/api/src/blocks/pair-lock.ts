import type { Prisma } from '@prisma/client';

/**
 * Namespace for the two-key form of `pg_advisory_xact_lock`. The two-int form
 * is a different key space from the single-bigint form
 * `MatchesService.createMatchGuarded` uses for its per-user locks, so a pair
 * lock can never collide with a per-user lock.
 */
const USER_PAIR_LOCK_NAMESPACE = 1201;

/**
 * A pair of user ids in canonical order: `low` sorts before `high` by a plain
 * (code-unit) string comparison - the same order the database uses under the
 * "C" collation, which is what the `friendships` and `friend_requests` CHECK
 * constraints assume.
 */
export function orderPair(
  userIdA: string,
  userIdB: string,
): { low: string; high: string } {
  return userIdA < userIdB
    ? { low: userIdA, high: userIdB }
    : { low: userIdB, high: userIdA };
}

/** The unordered-pair key `lowId:highId` (pair lock key, `pendingPairKey`). */
export function pairKeyOf(userIdA: string, userIdB: string): string {
  const { low, high } = orderPair(userIdA, userIdB);
  return `${low}:${high}`;
}

/**
 * Serialises every social mutation and challenge acceptance between one pair
 * of users (Phase 12 — ADR-026, "Pair lock").
 *
 * There is no single row to lock for "this pair's social state" (a block, a
 * challenge, a friend request and a friendship are separate rows, and the
 * interesting races are about rows that do not exist yet), so this takes a
 * Postgres advisory *transaction* lock keyed on the unordered pair. The lock
 * is released automatically at commit or rollback.
 *
 * The ids are sorted so `lockUserPair(tx, a, b)` and `lockUserPair(tx, b, a)`
 * hit the same key. **Lock ordering rule:** acquire the pair lock *first* in
 * a transaction, before locking or claiming any challenge/friend-request row,
 * before `lockFriendSlots`, and before `createMatchGuarded`'s per-user locks.
 * Every transaction in this codebase that takes it follows that order, which
 * is what rules out a deadlock between them.
 */
export async function lockUserPair(
  tx: Prisma.TransactionClient,
  userIdA: string,
  userIdB: string,
): Promise<void> {
  const pairKey = pairKeyOf(userIdA, userIdB);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USER_PAIR_LOCK_NAMESPACE}::int, hashtext(${pairKey}))`;
}
