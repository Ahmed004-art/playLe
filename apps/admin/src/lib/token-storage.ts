/**
 * Session token persistence for the admin app.
 *
 * Known limitation (Phase 2): tokens are kept in `localStorage`, which is
 * readable by any script on the page (XSS risk) — acceptable for this
 * foundation phase, which has no real admin operations to protect yet
 * (see docs/architecture/SECURITY.md). A hardened admin build should move
 * to httpOnly, SameSite cookies set by the API, which requires backend
 * support this phase doesn't add. Guarded against SSR (`window` is
 * undefined during server rendering) since Next.js renders this on the
 * server first.
 */
const ACCESS_TOKEN_KEY = 'playle_admin_access_token';
const REFRESH_TOKEN_KEY = 'playle_admin_refresh_token';

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export const tokenStorage = {
  getAccessToken(): string | null {
    if (!isBrowser()) return null;
    return window.localStorage.getItem(ACCESS_TOKEN_KEY);
  },
  getRefreshToken(): string | null {
    if (!isBrowser()) return null;
    return window.localStorage.getItem(REFRESH_TOKEN_KEY);
  },
  setTokens(accessToken: string, refreshToken: string): void {
    if (!isBrowser()) return;
    window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  },
  clear(): void {
    if (!isBrowser()) return;
    window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  },
};
