'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  ApiRequestError,
  fetchCurrentUser,
  login as apiLogin,
  logout as apiLogout,
} from './api-client';
import { tokenStorage } from './token-storage';
import type { AdminUser } from './auth-types';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: AdminUser | null;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Admin authentication state. The backend is the real authorization
 * boundary (every admin-only API call is enforced server-side regardless
 * of what this context thinks) — this just drives the admin UI: who's
 * logged in, and whether they're allowed into the admin app at all (only
 * `role === 'ADMIN'` accounts may use it; a successfully-authenticated
 * non-admin is immediately logged back out of this app).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AdminUser | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function restore() {
      if (!tokenStorage.getAccessToken()) {
        if (!cancelled) setStatus('unauthenticated');
        return;
      }
      try {
        const current = await fetchCurrentUser();
        if (cancelled) return;
        if (current.role !== 'ADMIN') {
          tokenStorage.clear();
          setStatus('unauthenticated');
          return;
        }
        setUser(current);
        setStatus('authenticated');
      } catch {
        if (!cancelled) {
          tokenStorage.clear();
          setStatus('unauthenticated');
        }
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    const response = await apiLogin(identifier, password);

    if (response.user.role !== 'ADMIN') {
      // Don't persist tokens for a non-admin account — this app is
      // admin-only, even though the backend would happily authenticate
      // any valid user. Defense in depth on top of server-side role checks.
      throw new ApiRequestError('This account does not have admin access.', 403);
    }

    tokenStorage.setTokens(response.accessToken, response.refreshToken);
    setUser(response.user);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    tokenStorage.clear();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  return (
    <AuthContext.Provider value={{ status, user, login, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
