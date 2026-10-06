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

  it('shows the financial section when the match has a stake and settlement', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        // Registered before the base match route: the financial URL
        // ("/admin/matches/match-1/financial") contains the base match
        // path as a substring, so the more specific route must be
        // checked first by mockFetchRoutedByUrl's in-order matching.
        '/admin/matches/match-1/financial': {
          stake: {
            id: 'stake-1',
            status: 'SETTLED',
            currency: 'SLE',
            stakeAmountMinor: '10000',
            poolAmountMinor: '20000',
            players: [
              { userId: 'user-1', heldAt: new Date().toISOString() },
              { userId: 'user-2', heldAt: new Date().toISOString() },
            ],
          },
          settlement: {
            id: 'settlement-1',
            outcome: 'WIN',
            status: 'COMPLETED',
            currency: 'SLE',
            poolAmountMinor: '20000',
            platformFeeAmountMinor: '2000',
            entries: [
              {
                userId: 'user-1',
                role: 'WINNER',
                availableDeltaMinor: '18000',
                heldDeltaMinor: '-10000',
              },
              {
                userId: 'user-2',
                role: 'LOSER',
                availableDeltaMinor: '0',
                heldDeltaMinor: '-10000',
              },
            ],
            completedAt: new Date().toISOString(),
          },
        },
        '/admin/matches/match-1': COMPLETED_MATCH,
        '/auth/me': ADMIN_USER,
      }),
    );

    render(
      <AuthProvider>
        <MatchDetailPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('Financial')).toBeInTheDocument());
    expect(screen.getByText('SETTLED')).toBeInTheDocument();
    expect(screen.getByText('Le 100.00')).toBeInTheDocument(); // stake amount
    expect(screen.getAllByText('Le 200.00').length).toBeGreaterThan(0); // prize pool
    expect(screen.getByText('Le 20.00')).toBeInTheDocument(); // platform fee
    expect(screen.getByText('WINNER')).toBeInTheDocument();
    expect(screen.getByText('Le 180.00')).toBeInTheDocument(); // winner available delta
  });

  it('shows no financial section for a free-play match (stake and settlement both null)', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/admin/matches/match-1/financial': { stake: null, settlement: null },
        '/admin/matches/match-1': COMPLETED_MATCH,
        '/auth/me': ADMIN_USER,
      }),
    );

    render(
      <AuthProvider>
        <MatchDetailPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('COMPLETED')).toBeInTheDocument());
    expect(screen.queryByText('Financial')).not.toBeInTheDocument();
  });
});
