import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/lib/auth-context';
import ResponsibleGamingPage from './page';

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

const USAGE = {
  windowHours: 24,
  stakeHeldMinor: '1000',
  lossMinor: '500',
  depositedMinor: '2000',
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

describe('ResponsibleGamingPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows usage and restriction history for a looked-up user ID', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/admin/session/me': ADMIN_USER,
        '/admin/responsible-gaming/user-1/usage': USAGE,
        '/admin/responsible-gaming?userId=user-1': [
          {
            id: 'r-1',
            userId: 'user-1',
            type: 'LOSS_LIMIT',
            status: 'ACTIVE',
            config: { limitMinor: '10000' },
            startsAt: new Date().toISOString(),
            endsAt: null,
            liftedAt: null,
            liftedReason: null,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );

    render(
      <AuthProvider>
        <ResponsibleGamingPage />
      </AuthProvider>,
    );

    fireEvent.change(await screen.findByPlaceholderText('User ID'), {
      target: { value: 'user-1' },
    });
    fireEvent.click(screen.getByText('Look up'));

    await waitFor(() => expect(screen.getByText('LOSS_LIMIT')).toBeInTheDocument());
    expect(screen.getByText('Le 10.00')).toBeInTheDocument(); // the limit
    expect(screen.getByText('Le 5.00')).toBeInTheDocument(); // realized losses
    expect(screen.queryByText(/permanently self-excluded/i)).not.toBeInTheDocument();
  });

  it('flags an active self-exclusion with no lift control shown anywhere', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/admin/session/me': ADMIN_USER,
        '/admin/responsible-gaming/user-2/usage': {
          windowHours: 24,
          stakeHeldMinor: '0',
          lossMinor: '0',
          depositedMinor: '0',
        },
        '/admin/responsible-gaming?userId=user-2': [
          {
            id: 'r-2',
            userId: 'user-2',
            type: 'SELF_EXCLUSION',
            status: 'ACTIVE',
            config: {},
            startsAt: new Date().toISOString(),
            endsAt: null,
            liftedAt: null,
            liftedReason: null,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );

    render(
      <AuthProvider>
        <ResponsibleGamingPage />
      </AuthProvider>,
    );

    fireEvent.change(await screen.findByPlaceholderText('User ID'), {
      target: { value: 'user-2' },
    });
    fireEvent.click(screen.getByText('Look up'));

    await waitFor(() => expect(screen.getByText(/permanently self-excluded/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /lift/i })).not.toBeInTheDocument();
  });

  it('shows the API error message when the lookup fails', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRoutedByUrl({
        '/admin/session/me': ADMIN_USER,
      }),
    );

    render(
      <AuthProvider>
        <ResponsibleGamingPage />
      </AuthProvider>,
    );

    fireEvent.change(await screen.findByPlaceholderText('User ID'), {
      target: { value: 'missing-user' },
    });
    fireEvent.click(screen.getByText('Look up'));

    await waitFor(() => expect(screen.getByText('not found')).toBeInTheDocument());
  });
});
