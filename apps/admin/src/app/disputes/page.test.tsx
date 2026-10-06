import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';
import DisputesPage from './page';

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

const OPEN_DISPUTE = {
  id: 'dispute-1',
  matchId: 'match-1',
  raisedByUserId: 'user-1',
  reason: 'Opponent disconnected right before the result was recorded.',
  status: 'OPEN',
  resolution: null,
  resolvedByAdminId: null,
  createdAt: new Date().toISOString(),
  resolvedAt: null,
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

describe('DisputesPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStorage.clear();
  });

  it('lists disputes for an authenticated admin', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/auth/me': ADMIN_USER,
        '/admin/disputes': { items: [OPEN_DISPUTE], nextCursor: null },
      }),
    );

    render(
      <AuthProvider>
        <DisputesPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('View →')).toBeInTheDocument());
    expect(screen.getByRole('cell', { name: 'OPEN' })).toBeInTheDocument();
  });

  it('shows an empty-state message when there are no disputes in a status', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/auth/me': ADMIN_USER,
        '/admin/disputes': { items: [], nextCursor: null },
      }),
    );

    render(
      <AuthProvider>
        <DisputesPage />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText('No disputes in this status.')).toBeInTheDocument(),
    );
  });
});
