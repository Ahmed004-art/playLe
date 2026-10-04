/**
 * Cross-cutting constants shared between PlayLe's TypeScript applications
 * (api, admin). These are foundation-level values only — no business logic
 * is implemented here. See docs/architecture for the systems that will
 * consume these in later phases.
 */

export const PLAYLE_CURRENCY_CODE = 'SLE';

/** Platform fee taken from every match's total prize pool. */
export const PLATFORM_FEE_PERCENT = 10;

export const MIN_MATCH_PLAYERS = 2;
export const MAX_MATCH_PLAYERS = 4;

export const CURRENT_API_VERSION = 'v1';
