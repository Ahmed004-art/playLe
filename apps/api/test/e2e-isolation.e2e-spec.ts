import buildConfiguration from '../src/config/configuration.js';

/**
 * Guards the isolation set up in `vitest.config.e2e.ts`: the background
 * sweeps must not fire during an e2e run, whatever the surrounding
 * environment (CI sets a 2s match sweep interval for its own shell). Needs
 * no database.
 */
describe('e2e isolation', () => {
  const ONE_HOUR_MS = 60 * 60 * 1000;

  it('keeps the match timeout sweep out of reach of every test', () => {
    expect(
      buildConfiguration().matches.timeoutSweepIntervalMs,
    ).toBeGreaterThanOrEqual(ONE_HOUR_MS);
  });

  it('keeps the notification dispatcher sweep out of reach of every test', () => {
    expect(
      buildConfiguration().notifications.dispatchSweepIntervalMs,
    ).toBeGreaterThanOrEqual(ONE_HOUR_MS);
  });
});
