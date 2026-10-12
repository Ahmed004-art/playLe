import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from './AuthGuard';
import { AuthProvider } from '@/lib/auth-context';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));

describe('AuthGuard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    replace.mockClear();
  });

  it('redirects to /login when GET /admin/session/me returns 401 (no session)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ message: 'Invalid or expired access token' }),
      }),
    );

    render(
      <AuthProvider>
        <AuthGuard>
          <div>Protected content</div>
        </AuthGuard>
      </AuthProvider>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('renders the protected content for an authenticated admin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'user-1',
          email: 'admin@example.com',
          phoneNumber: null,
          username: 'theadmin',
          displayName: null,
          avatarUrl: null,
          role: 'ADMIN',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
        }),
      }),
    );

    render(
      <AuthProvider>
        <AuthGuard>
          <div>Protected content</div>
        </AuthGuard>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('Protected content')).toBeInTheDocument());
    expect(replace).not.toHaveBeenCalled();
  });
});
