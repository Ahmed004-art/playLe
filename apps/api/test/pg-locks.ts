import type { PrismaService } from '../src/prisma/prisma.service.js';

export interface BlockedBackend {
  pid: number;
  wait_event_type: string | null;
  query: string;
}

/**
 * Resolves with the backends that Postgres reports as blocked by
 * `blockerPid`, polling `pg_blocking_pids` from the caller's own connection
 * until at least one appears. A bounded condition wait, not a sleep: it
 * returns the moment the block is visible and throws if it never is within
 * `timeoutMs`, so a lock dependency that does not exist fails loudly instead
 * of hanging or passing vacuously.
 */
export async function waitForBackendBlockedBy(
  prisma: PrismaService,
  blockerPid: number,
  timeoutMs = 5000,
): Promise<BlockedBackend[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const rows = await prisma.$queryRaw<BlockedBackend[]>`
      SELECT pid, wait_event_type, query FROM pg_stat_activity
      WHERE ${blockerPid}::int = ANY(pg_blocking_pids(pid))`;
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `No backend became blocked by pid ${blockerPid} within ${timeoutMs}ms`,
  );
}
