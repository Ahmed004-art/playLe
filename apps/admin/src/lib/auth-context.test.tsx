import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './auth-context';

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
    document.cookie = 'admin_csrf_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/';
  });

  it('restores an authenticated admin session via GET /admin/session/me (cookie-based, no token check)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ADMIN_USER });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProvider();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('username')).toHaveTextContent('theadmin');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/admin/session/me');
    expect(init?.credentials).toBe('include');
    // No Authorization header — the session travels as an httpOnly cookie.
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  it('lands unauthenticated when /admin/session/me returns 401 on initial load, without crashing', async () => {
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
    expect(screen.getByTestId('username')).toHaveTextContent('');
  });

  it('logs in an admin successfully using only the returned user body (no tokens anywhere)', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/admin/session/me')) {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: async () => ({ message: 'Invalid or expired access token' }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ADMIN_USER });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await act(async () => {
      screen.getByText('login').click();
    });

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('username')).toHaveTextContent('theadmin');

    const loginCall = fetchMock.mock.calls.find((call) => call[0].includes('/admin/session/login'));
    expect(loginCall).toBeDefined();
    const [, init] = loginCall as [string, RequestInit];
    expect(init?.credentials).toBe('include');
    expect(JSON.parse(init?.body as string)).toEqual({
      identifier: 'admin@example.com',
      password: 'Passw0rd1',
    });
    // The response body is the bare user object — nothing token-shaped was
    // read off it, and nothing was ever written to localStorage.
    expect(window.localStorage.length).toBe(0);
  });

  it('a failed login (401) never sets authenticated state', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/admin/session/me')) {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: async () => ({ message: 'Invalid or expired access token' }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 401,
        json: async () => ({ message: 'Invalid credentials' }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await act(async () => {
      screen.getByText('login').click();
    });

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(screen.getByTestId('username')).toHaveTextContent('');
  });

  it('logs out, resets state, and sends the CSRF header on the logout call', async () => {
    document.cookie = 'admin_csrf_token=csrf-abc123; path=/';

    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ADMIN_USER });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => undefined }),
    );
    const logoutFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await act(async () => {
      screen.getByText('logout').click();
    });

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    const [url, init] = logoutFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/admin/session/logout');
    expect(init?.credentials).toBe('include');
    expect((init?.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-abc123');
  });
});
