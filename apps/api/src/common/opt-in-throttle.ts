import type { ExecutionContext } from '@nestjs/common';

/**
 * Keeps a named throttler limited to the routes that ask for it (Phase 13).
 *
 * `@nestjs/throttler` applies *every* registered named throttler to *every*
 * route unless told to skip it. Left like that, `auth` (5 requests/minute in
 * production), `payments`, `matches` and `stakes` each also capped ordinary
 * authenticated reads such as `GET /matches` or `GET /friends`, so a player
 * using the app normally was answered 429 after a handful of requests, and
 * webhooks and admin actions shared the same tiny budgets.
 *
 * A route opts in by carrying `@Throttle({ <name>: {} })`, which stores
 * `THROTTLER:LIMIT<name>` metadata (value `undefined` when no override is
 * given). This `skipIf` skips the throttler unless that metadata is present on
 * the handler or its controller. Routes that were already decorated behave
 * exactly as before.
 */
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';

export function optInThrottleSkipIf(
  name: string,
): (context: ExecutionContext) => boolean {
  const key = THROTTLER_LIMIT + name;
  return (context) =>
    !(
      Reflect.hasMetadata(key, context.getHandler()) ||
      Reflect.hasMetadata(key, context.getClass())
    );
}
