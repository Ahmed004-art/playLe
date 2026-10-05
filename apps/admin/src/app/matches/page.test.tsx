import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';
import MatchesPage from './page';

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

const ACTIVE_MATCH = {
  id: 'match-1',
  gameId: 'tic_tac_toe',
  gameVersion: 1,
  status: 'ACTIVE',
  stateVersion: 2,
  state: { board: ['X', null, null, null, 'O', null, null, null, null] },
  winnerUserId: null,
  resultIsDraw: false,
  terminationReason: null,
  players: [
    { userId: 'user-1', seat: 0, connected: true },
    { userId: 'user-2', seat: 1, connected: true },
  ],
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  completedAt: null,
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

describe('MatchesPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStorage.clear();
  });

  it('lists matches for an authenticated admin', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/auth/me': ADMIN_USER,
        '/admin/matches': { items: [ACTIVE_MATCH], nextCursor: null },
      }),
    );

    render(
      <AuthProvider>
        <MatchesPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('tic_tac_toe')).toBeInTheDocument());
    expect(screen.getByRole('cell', { name: 'ACTIVE' })).toBeInTheDocument();
  });

  it('shows an empty-state message when there are no matches in a status', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/auth/me': ADMIN_USER,
        '/admin/matches': { items: [], nextCursor: null },
      }),
    );

    render(
      <AuthProvider>
        <MatchesPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('No matches in this status.')).toBeInTheDocument());
  });

  it('has no action to set or override a match result', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/auth/me': ADMIN_USER,
        '/admin/matches': { items: [ACTIVE_MATCH], nextCursor: null },
      }),
    );

    render(
      <AuthProvider>
        <MatchesPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('tic_tac_toe')).toBeInTheDocument());
    expect(screen.queryByText(/set winner/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /winner|override/i })).not.toBeInTheDocument();
  });
});
