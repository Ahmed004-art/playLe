import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth-context';
import PaymentsPage from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

const ADMIN_USER = {
  id: 'admin-1',
  email: 'admin@example.com',
  phoneNumber: null,
  username: 'theadmin',
  displayName: null,
  avatarUrl: null,
  role: 'ADMIN' as const,
  status: 'ACTIVE' as const,
  createdAt: new Date().toISOString(),
};

const ANOMALY = {
  id: 'anomaly-1',
  type: 'UNKNOWN_PAYOUT_OUTCOME',
  relatedDepositId: null,
  relatedWithdrawalId: 'withdrawal-12345678',
  details: { detail: 'Payout submission outcome has been UNKNOWN' },
  status: 'OPEN',
  resolutionNote: null,
  detectedAt: new Date().toISOString(),
  resolvedAt: null,
};

function mockFetch(routes: Record<string, unknown>) {
  return vi.fn((url: string) => {
    for (const [path, body] of Object.entries(routes)) {
      if (url.includes(path)) {
        return Promise.resolve({ ok: true, status: 200, json: async () => body });
      }
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      json: async () => ({ message: 'not found' }),
    });
  });
}

describe('PaymentsPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists open payment problems with their detail', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/admin/session/me': ADMIN_USER,
        '/admin/payment-reconciliation/anomalies': { items: [ANOMALY], nextCursor: null },
      }),
    );

    render(
      <AuthProvider>
        <PaymentsPage />
      </AuthProvider>,
    );

    expect(await screen.findByText('UNKNOWN_PAYOUT_OUTCOME')).toBeInTheDocument();
    expect(screen.getByText('Payout submission outcome has been UNKNOWN')).toBeInTheDocument();
    expect(screen.getByText('withdrawal withdraw…')).toBeInTheDocument();
  });

  it('resolves only with a note of at least 10 characters, sent to the API', async () => {
    const fetchMock = mockFetch({
      '/admin/session/me': ADMIN_USER,
      '/resolve': { ...ANOMALY, status: 'RESOLVED' },
      '/admin/payment-reconciliation/anomalies': { items: [ANOMALY], nextCursor: null },
    });
    vi.stubGlobal('fetch', fetchMock);
    const prompt = vi
      .fn()
      .mockReturnValueOnce('short')
      .mockReturnValueOnce('Checked with Monime: failed');
    vi.stubGlobal('prompt', prompt);
    vi.stubGlobal('alert', vi.fn());

    render(
      <AuthProvider>
        <PaymentsPage />
      </AuthProvider>,
    );

    fireEvent.click(await screen.findByText('Mark resolved'));
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/resolve'))).toHaveLength(0);

    fireEvent.click(screen.getByText('Mark resolved'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/resolve'))).toBe(true),
    );
  });
});
