import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';
import DisputeDetailPage from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useParams: () => ({ id: 'dispute-1' }),
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

const RESOLVED_DISPUTE = {
  ...OPEN_DISPUTE,
  status: 'RESOLVED',
  resolution: 'Reviewed replay; outcome stands as settled.',
  resolvedByAdminId: 'admin-1',
  resolvedAt: new Date().toISOString(),
};

function mockFetchRoutedByUrl(routes: Record<string, unknown>) {
  return vi.fn((url: string, init?: RequestInit) => {
    void init;
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

describe('DisputeDetailPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStorage.clear();
  });

  it('shows the dispute detail and resolve form for an open dispute', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/auth/me': ADMIN_USER,
        '/admin/disputes/dispute-1': OPEN_DISPUTE,
      }),
    );

    render(
      <AuthProvider>
        <DisputeDetailPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('Submit resolution')).toBeInTheDocument());
    expect(screen.getByText(OPEN_DISPUTE.reason)).toBeInTheDocument();
  });

  it('has no amount or refund input anywhere on the resolve form', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/auth/me': ADMIN_USER,
        '/admin/disputes/dispute-1': OPEN_DISPUTE,
      }),
    );

    render(
      <AuthProvider>
        <DisputeDetailPage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('Submit resolution')).toBeInTheDocument());

    // Admin safety: resolving a dispute is status + audit only. There must
    // be no numeric amount/refund field, and no control that implies money
    // moves as part of this action.
    expect(screen.queryByLabelText(/amount/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/amount/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/refund amount/i)).not.toBeInTheDocument();
    const numberInputs = document.querySelectorAll('input[type="number"]');
    expect(numberInputs).toHaveLength(0);
  });

  it('requires a resolution of at least 10 characters before submitting', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    const fetchMock = mockFetchRoutedByUrl({
      '/auth/me': ADMIN_USER,
      '/admin/disputes/dispute-1': OPEN_DISPUTE,
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <DisputeDetailPage />
      </AuthProvider>,
    );

    const submitButton = await screen.findByText('Submit resolution');
    fireEvent.change(screen.getByLabelText('Resolution note'), { target: { value: 'short' } });
    fireEvent.click(submitButton);

    expect(screen.getByText('Resolution must be at least 10 characters.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter((call) => call[0].includes('/resolve'))).toHaveLength(0);
  });

  it('submits the resolve action with the selected status and resolution text', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    const fetchMock = mockFetchRoutedByUrl({
      '/auth/me': ADMIN_USER,
      '/admin/disputes/dispute-1/resolve': RESOLVED_DISPUTE,
      '/admin/disputes/dispute-1': OPEN_DISPUTE,
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <DisputeDetailPage />
      </AuthProvider>,
    );

    const submitButton = await screen.findByText('Submit resolution');
    fireEvent.change(screen.getByLabelText('Resolution note'), {
      target: { value: 'Reviewed replay; outcome stands as settled.' },
    });
    fireEvent.click(submitButton);

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => call[0].includes('/resolve'))).toBe(true),
    );
    const resolveCall = fetchMock.mock.calls.find((call) => call[0].includes('/resolve'));
    const body = JSON.parse(resolveCall?.[1]?.body as string);
    expect(body).toEqual({
      status: 'UNDER_REVIEW',
      resolution: 'Reviewed replay; outcome stands as settled.',
    });
  });

  it('shows a final-state message instead of the resolve form for a resolved dispute', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/auth/me': ADMIN_USER,
        '/admin/disputes/dispute-1': RESOLVED_DISPUTE,
      }),
    );

    render(
      <AuthProvider>
        <DisputeDetailPage />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText('This dispute is already in a final state.')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Submit resolution')).not.toBeInTheDocument();
  });
});
