import { FINANCIAL_TRANSACTION_OPTIONS } from '../common/prisma-transaction.constants.js';

/**
 * `failureReason` of a payout attempt for which no request was sent (the
 * provider was unavailable or unconfigured). Such an attempt cannot have paid
 * anyone, so a manual completion after it is not a contradiction.
 */
export const NO_PAYOUT_REQUEST_SENT =
  'Provider unavailable — no live call made';

/**
 * How long a payout attempt may stay PENDING on a still-APPROVED withdrawal
 * before it is reported as interrupted. Far above the provider HTTP timeout
 * (10 s by default), so a request still in flight is not reported.
 */
export const INTERRUPTED_PAYOUT_THRESHOLD_MS = 5 * 60 * 1000;

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
