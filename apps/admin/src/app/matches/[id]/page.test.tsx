import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';
import MatchDetailPage from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useParams: () => ({ id: 'match-1' }),
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

const COMPLETED_MATCH = {
  id: 'match-1',
  gameId: 'tic_tac_toe',
  gameVersion: 1,
  status: 'COMPLETED',
  stateVersion: 5,
  state: { board: ['X', 'X', 'X', null, 'O', null, null, null, null] },
  winnerUserId: 'user-1',
  resultIsDraw: false,
  terminationReason: null,
  players: [
    { userId: 'user-1', seat: 0, connected: true },
    { userId: 'user-2', seat: 1, connected: false },
  ],
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
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

describe('MatchDetailPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStorage.clear();
  });

  it('shows the match status, winner, and players for an authenticated admin', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/auth/me': ADMIN_USER,
        '/admin/matches/match-1': COMPLETED_MATCH,
      }),
    );

    render(
      <AuthProvider>
        <MatchDetailPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('COMPLETED')).toBeInTheDocument());
    expect(screen.getByText('Winner: user-1')).toBeInTheDocument();
    expect(screen.getByText('user-2')).toBeInTheDocument();
  });

  it('surfaces a load failure as an error message', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/auth/me': ADMIN_USER,
      }),
    );

    render(
      <AuthProvider>
        <MatchDetailPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('not found')).toBeInTheDocument());
  });

  it('has no action to set or override the match result', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/auth/me': ADMIN_USER,
        '/admin/matches/match-1': COMPLETED_MATCH,
      }),
    );

    render(
      <AuthProvider>
        <MatchDetailPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('COMPLETED')).toBeInTheDocument());
    expect(
      screen.queryByRole('button', { name: /winner|override|set result/i }),
    ).not.toBeInTheDocument();
  });
});
