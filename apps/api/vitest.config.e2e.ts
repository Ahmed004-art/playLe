import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Every e2e file boots its own Nest app against the one shared Postgres and
 * Redis. Two things used to let one test interfere with another:
 *
 * - each app ran its own background sweep (`MatchTimeoutService`,
 *   `NotificationDispatcherService`), and those sweeps read the whole
 *   database - so any app could cancel, abandon, time out or deliver rows
 *   that a test in *another* file had just backdated or enqueued and was
 *   about to assert on;
 * - the files ran in parallel, so a test's own explicit `sweep()` could do
 *   the same to a neighbouring file's rows.
 *
 * No e2e test relies on a timer: every time-based transition is driven by an
 * explicit `sweep()` / `processTurnTimeout()` call, so the timers are pushed
 * out of reach (an hour) and files run one at a time. That the services do
 * schedule their sweeps is covered by unit specs with fake timers.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    fileParallelism: false,
    env: {
      MATCH_TIMEOUT_SWEEP_INTERVAL_MS: '3600000',
      NOTIFICATION_DISPATCH_SWEEP_INTERVAL_MS: '3600000',
    },
  },
});
