import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthStatus } from './HealthStatus';

describe('HealthStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders up statuses when the API reports healthy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'ok',
          timestamp: new Date().toISOString(),
          checks: { postgres: 'up', redis: 'up' },
        }),
      }),
    );

    render(<HealthStatus />);

    await waitFor(() => expect(screen.getByText(/PostgreSQL: up/)).toBeInTheDocument());
    expect(screen.getByText(/Redis: up/)).toBeInTheDocument();
  });

  it('renders an error message when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    render(<HealthStatus />);

    await waitFor(() => expect(screen.getByText(/API unreachable/)).toBeInTheDocument());
  });
});
