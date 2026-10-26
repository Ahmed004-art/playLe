import { SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

const SOCIAL_THROTTLE_KEY = 'playle:social-throttle';

/**
 * Opts a route (or controller) into the `social` named throttler (Phase 12 —
 * ADR-026).
 *
 * `@nestjs/throttler` applies *every* named throttler to *every* route unless
 * told to skip it, so merely registering `social` would also rate-limit all
 * existing routes at the social limit. `socialThrottleSkipIf` inverts that:
 * `social` is skipped unless a route carries this marker, so no existing
 * endpoint's behavior changes.
 */
export const SocialThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SOCIAL_THROTTLE_KEY, true);

const reflector = new Reflector();

/** `skipIf` for the `social` throttler: skip every route not marked `@SocialThrottle()`. */
export function socialThrottleSkipIf(context: ExecutionContext): boolean {
  return !reflector.getAllAndOverride<boolean | undefined>(
    SOCIAL_THROTTLE_KEY,
    [context.getHandler(), context.getClass()],
  );
}
