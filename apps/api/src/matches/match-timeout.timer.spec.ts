import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchTimeoutService } from './match-timeout.service.js';

/**
 * The periodic timer itself. The e2e suite drives every sweep explicitly and
 * keeps the background timer out of reach (see `vitest.config.e2e.ts`), so
 * this is what pins that the service really schedules `sweep()` at the
 * configured interval, survives a failing sweep, and stops on shutdown.
 */
describe('MatchTimeoutService timer', () => {
  const INTERVAL_MS = 1000;

  function build() {
    const configService = { get: vi.fn().mockReturnValue(INTERVAL_MS) };
    const service = new MatchTimeoutService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      configService as never,
    );
    return { service, configService };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs sweep() once per configured interval, not before', () => {
    const { service, configService } = build();
    const sweep = vi.spyOn(service, 'sweep').mockResolvedValue();

    service.onModuleInit();
    expect(configService.get).toHaveBeenCalledWith(
      'matches.timeoutSweepIntervalMs',
      { infer: true },
    );
    vi.advanceTimersByTime(INTERVAL_MS - 1);
    expect(sweep).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(3);

    service.onModuleDestroy();
  });

  it('keeps ticking after a sweep rejects', async () => {
    const { service } = build();
    const sweep = vi
      .spyOn(service, 'sweep')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue();

    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(2 * INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
  });

  it('stops sweeping once the module is destroyed', () => {
    const { service } = build();
    const sweep = vi.spyOn(service, 'sweep').mockResolvedValue();

    service.onModuleInit();
    service.onModuleDestroy();
    vi.advanceTimersByTime(5 * INTERVAL_MS);
    expect(sweep).not.toHaveBeenCalled();
  });
});
