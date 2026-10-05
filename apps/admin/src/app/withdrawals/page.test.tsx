import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';
import WithdrawalsPage from './page';

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

const PENDING_WITHDRAWAL = {
  id: 'withdrawal-1',
  amountMinor: '5000',
  currency: 'SLE',
  status: 'PENDING_REVIEW',
  destinationDetails: { method: 'ORANGE_MONEY' },
  reviewedByAdminId: null,
  reviewReason: null,
  providerReference: null,
  failureReason: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function mockFetchRoutedByUrl(routes: Record<string, unknown>) {
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

describe('WithdrawalsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStorage.clear();
  });

  it('lists pending withdrawals for an authenticated admin', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/auth/me': ADMIN_USER,
        '/admin/withdrawals': { items: [PENDING_WITHDRAWAL], nextCursor: null },
      }),
    );

    render(
      <AuthProvider>
        <WithdrawalsPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('Approve')).toBeInTheDocument());
    expect(screen.getByText('Le 50.00')).toBeInTheDocument();
  });

  it('requires a reason of at least 10 characters before approving', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    const fetchMock = mockFetchRoutedByUrl({
      '/auth/me': ADMIN_USER,
      '/admin/withdrawals': { items: [PENDING_WITHDRAWAL], nextCursor: null },
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'prompt',
      vi.fn(() => 'short'),
    );
    vi.stubGlobal('alert', vi.fn());

    render(
      <AuthProvider>
        <WithdrawalsPage />
      </AuthProvider>,
    );

    const approveButton = await screen.findByText('Approve');
    fireEvent.click(approveButton);

    expect(window.alert).toHaveBeenCalledWith('Reason must be at least 10 characters.');
    // No POST was made for the approval itself — only the two GETs for
    // session restore and the withdrawal list.
    expect(fetchMock.mock.calls.filter((call) => call[0].includes('/approve'))).toHaveLength(0);
  });

  it('sends the approve action with the provided reason', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    const fetchMock = mockFetchRoutedByUrl({
      '/auth/me': ADMIN_USER,
      '/admin/withdrawals/withdrawal-1/approve': { ...PENDING_WITHDRAWAL, status: 'APPROVED' },
      '/admin/withdrawals': { items: [PENDING_WITHDRAWAL], nextCursor: null },
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'prompt',
      vi.fn(() => 'Verified identity via support ticket #1'),
    );

    render(
      <AuthProvider>
        <WithdrawalsPage />
      </AuthProvider>,
    );

    const approveButton = await screen.findByText('Approve');
    fireEvent.click(approveButton);

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => call[0].includes('/approve'))).toBe(true),
    );
  });
});
