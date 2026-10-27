import { FINANCIAL_TRANSACTION_OPTIONS } from '../common/prisma-transaction.constants.js';

/** How long a withdrawal may sit in PROCESSING before it's flagged as stuck. */
export const STUCK_PROCESSING_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * The longest a webhook's money transaction can run before the database or
 * Prisma gives up on it: waiting for a connection, then running.
 */
export const LONGEST_FINANCIAL_TRANSACTION_MS =
  FINANCIAL_TRANSACTION_OPTIONS.maxWait + FINANCIAL_TRANSACTION_OPTIONS.timeout;

/**
 * Bounds for `PROVIDER_EVENT_STALE_AFTER_MS` (Phase 13): how long a verified
 * provider event may stay `RECEIVED` before it is reported.
 *
 * - Lower bound 5 minutes - twenty times the longest a money transaction can
 *   run (15 s), so an event that is merely still being processed, or waiting
 *   for a retry that is about to arrive, is never reported.
 * - Upper bound 45 minutes - below the 60-minute stuck-withdrawal threshold,
 *   so an unfinished payout event is reported before its withdrawal is.
 * - Default 15 minutes.
 */
export const PROVIDER_EVENT_STALE_MIN_MS = 5 * 60 * 1000;
export const PROVIDER_EVENT_STALE_MAX_MS = 45 * 60 * 1000;
export const PROVIDER_EVENT_STALE_DEFAULT_MS = 15 * 60 * 1000;
