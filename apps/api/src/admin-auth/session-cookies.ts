import { randomBytes } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import type { IssuedTokenPair } from '../auth/token.service.js';

export const ADMIN_ACCESS_COOKIE = 'admin_access_token';
export const ADMIN_REFRESH_COOKIE = 'admin_refresh_token';
export const ADMIN_CSRF_COOKIE = 'admin_csrf_token';

/** Type-safe read of one cookie — `cookie-parser` types `req.cookies` as `any`. */
export function getCookie(req: Request, name: string): string | undefined {
  const cookies: unknown = req.cookies;
  if (!cookies || typeof cookies !== 'object') return undefined;
  const value = (cookies as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

function baseOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure,
    // Admin (e.g. :3001) and API (e.g. :3000) are different ports but
    // the same *site* in every environment this runs in (same apex
    // domain in production, both "localhost" in dev) — `Lax` is
    // sufficient and avoids `SameSite=None`'s mandatory-`Secure`
    // requirement breaking local HTTP dev.
    sameSite: 'lax',
    path: '/',
  };
}

/** Sets the httpOnly session cookies and a fresh, readable CSRF cookie. */
export function setSessionCookies(
  res: Response,
  tokens: IssuedTokenPair,
  opts: { secureCookies: boolean; accessTokenCookieTtlMs: number },
): void {
  const base = baseOptions(opts.secureCookies);

  res.cookie(ADMIN_ACCESS_COOKIE, tokens.accessToken, {
    ...base,
    maxAge: opts.accessTokenCookieTtlMs,
  });
  res.cookie(ADMIN_REFRESH_COOKIE, tokens.refreshToken, {
    ...base,
    maxAge: tokens.refreshTokenExpiresAt.getTime() - Date.now(),
  });
  // Deliberately NOT httpOnly — the frontend must be able to read this
  // value to echo it back in the X-CSRF-Token header.
  res.cookie(ADMIN_CSRF_COOKIE, randomBytes(32).toString('base64url'), {
    ...base,
    httpOnly: false,
    maxAge: tokens.refreshTokenExpiresAt.getTime() - Date.now(),
  });
}

export function clearSessionCookies(
  res: Response,
  opts: { secureCookies: boolean },
): void {
  const base = baseOptions(opts.secureCookies);
  res.clearCookie(ADMIN_ACCESS_COOKIE, base);
  res.clearCookie(ADMIN_REFRESH_COOKIE, base);
  res.clearCookie(ADMIN_CSRF_COOKIE, { ...base, httpOnly: false });
}
