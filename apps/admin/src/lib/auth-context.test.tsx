import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './auth-context';
import { tokenStorage } from './token-storage';

const ADMIN_USER = {
  id: 'user-1',
  email: 'admin@example.com',
  phoneNumber: null,
  username: 'theadmin',
  displayName: null,
  avatarUrl: null,
  role: 'ADMIN' as const,
  status: 'ACTIVE' as const,
  createdAt: new Date().toISOString(),
};

const PLAIN_USER = { ...ADMIN_USER, role: 'USER' as const };

function Probe() {
  const { status, user, login, logout } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="username">{user?.username ?? ''}</span>
      <button onClick={() => login('admin@example.com', 'Passw0rd1').catch(() => {})}>login</button>
      <button onClick={() => logout()}>logout</button>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

describe('AuthProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStorage.clear();
  });

  it('starts unauthenticated when there is no stored token', async () => {
    renderWithProvider();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
  });

  it('restores an authenticated admin session from a valid stored token', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ADMIN_USER }),
    );

    renderWithProvider();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('username')).toHaveTextContent('theadmin');
  });

  it('clears the session and lands unauthenticated when the stored token is invalid', async () => {
    tokenStorage.setTokens('stale-token', 'stale-refresh');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ message: 'Invalid or expired access token' }),
      }),
    );

    renderWithProvider();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(tokenStorage.getAccessToken()).toBeNull();
  });

  it('a non-admin login is rejected and no session is persisted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          user: PLAIN_USER,
          accessToken: 'at',
          refreshToken: 'rt',
          refreshTokenExpiresAt: new Date().toISOString(),
        }),
      }),
    );

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await act(async () => {
      screen.getByText('login').click();
    });

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(tokenStorage.getAccessToken()).toBeNull();
  });

  it('logs in an admin successfully and persists the session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          user: ADMIN_USER,
          accessToken: 'at',
          refreshToken: 'rt',
          refreshTokenExpiresAt: new Date().toISOString(),
        }),
      }),
    );

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await act(async () => {
      screen.getByText('login').click();
    });

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(tokenStorage.getAccessToken()).toBe('at');
  });

  it('logs out and clears the stored session', async () => {
    tokenStorage.setTokens('access-token', 'refresh-token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ADMIN_USER }),
    );

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => undefined }),
    );

    await act(async () => {
      screen.getByText('logout').click();
    });

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(tokenStorage.getAccessToken()).toBeNull();
  });
});
