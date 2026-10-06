import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';
import ReconciliationPage from './page';

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

describe('ReconciliationPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStorage.clear();
  });

  it('shows an empty-state message when a run finds no anomalies', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/auth/me': ADMIN_USER,
        '/admin/reconciliation/run': { generatedAt: new Date().toISOString(), anomalies: [] },
      }),
    );

    render(
      <AuthProvider>
        <ReconciliationPage />
      </AuthProvider>,
    );

    const button = await screen.findByText('Run reconciliation');
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('No anomalies found.')).toBeInTheDocument());
  });

  it('renders anomalies returned by a run', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/auth/me': ADMIN_USER,
        '/admin/reconciliation/run': {
          generatedAt: new Date().toISOString(),
          anomalies: [
            {
              type: 'ORPHANED_HOLD',
              matchStakeId: 'stake-1',
              detail: 'Stake held but match has no active settlement path.',
            },
          ],
        },
      }),
    );

    render(
      <AuthProvider>
        <ReconciliationPage />
      </AuthProvider>,
    );

    const button = await screen.findByText('Run reconciliation');
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('ORPHANED_HOLD')).toBeInTheDocument());
    expect(screen.getByText('stake-1')).toBeInTheDocument();
    expect(
      screen.getByText('Stake held but match has no active settlement path.'),
    ).toBeInTheDocument();
  });

  it('does not run automatically before the button is clicked', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    const fetchMock = mockFetchRoutedByUrl({
      '/auth/me': ADMIN_USER,
      '/admin/reconciliation/run': { generatedAt: new Date().toISOString(), anomalies: [] },
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <ReconciliationPage />
      </AuthProvider>,
    );

    await screen.findByText('Run reconciliation');
    expect(
      fetchMock.mock.calls.filter((call) => call[0].includes('/reconciliation/run')),
    ).toHaveLength(0);
  });
});
