/**
 * Options for every financial `$transaction` call that goes through
 * `LedgerService.applyEntry`'s row lock (`SELECT ... FOR UPDATE`).
 *
 * Prisma's defaults (`maxWait: 2000ms`, `timeout: 5000ms`) are tuned for
 * typical web requests, not for a transaction that may legitimately
 * block waiting for another transaction's row lock on the same wallet —
 * exactly what happens when two requests against the same wallet race
 * (confirmed by a real CI failure: a concurrency e2e test's losing
 * request got an unhandled 500 instead of the expected 422 because the
 * waiting transaction hit Prisma's default timeout before it could
 * acquire the lock and discover the balance was insufficient). Without
 * this, a transaction merely waiting its turn for a lock can be aborted
 * by Prisma's own timeout.
 */
export const FINANCIAL_TRANSACTION_OPTIONS = {
  maxWait: 5000,
  timeout: 10000,
} as const;
