import type { ApiErrorResponse } from '@playle/shared';
import { appConfig } from './config';
import type { AdminUser } from './auth-types';
import type {
  AdminWallet,
  AdminLedgerEntry,
  AdminDeposit,
  AdminWithdrawal,
  CursorPage,
} from './wallet-types';
import type { AdminMatch, AdminMatchFinancial } from './match-types';
import type { AdminDispute } from './dispute-types';
import type { ReconciliationReport } from './reconciliation-types';
import type {
  AdminResponsibleGamingRestriction,
  AdminResponsibleGamingUsage,
} from './responsible-gaming-types';

/**
 * API client abstraction. Admin UI code calls functions from this module
 * rather than using `fetch` directly, so the base URL, error handling, and
 * cookie/CSRF attachment stay in one place.
 */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

// --- Session cookies & CSRF (Phase 6 account-security hardening) ---
// The admin session now lives entirely in httpOnly cookies
// (`admin_access_token`, `admin_refresh_token`) set by the API — there is
// no token in the response body and nothing is stored in `localStorage`.
// `credentials: 'include'` on every request makes the browser attach
// those cookies automatically. The one cookie that is NOT httpOnly,
// `admin_csrf_token`, exists so this client can read it and echo it back
// as the `X-CSRF-Token` header on every mutating `/admin/*` request (the
// double-submit CSRF pattern) — the lone exception is logging in itself,
// since no CSRF cookie exists yet before a session does.
const CSRF_COOKIE_NAME = 'admin_csrf_token';
const CSRF_EXEMPT_PATHS = new Set(['/admin/session/login']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Reads a named cookie's value. Guarded for SSR, where `document` doesn't exist. */
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const pair of document.cookie.split('; ')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) continue;
    if (pair.slice(0, separatorIndex) === name) {
      return decodeURIComponent(pair.slice(separatorIndex + 1));
    }
  }
  return null;
}

function needsCsrfHeader(path: string, method: string): boolean {
  return (
    MUTATING_METHODS.has(method.toUpperCase()) &&
    path.startsWith('/admin') &&
    !CSRF_EXEMPT_PATHS.has(path)
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };

  if (needsCsrfHeader(path, init?.method ?? 'GET')) {
    const csrfToken = readCookie(CSRF_COOKIE_NAME);
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }

  const response = await fetch(`${appConfig.apiBaseUrl}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    const message = Array.isArray(body?.message)
      ? body.message.join(', ')
      : (body?.message ?? response.statusText);
    throw new ApiRequestError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export interface HealthCheckResponse {
  status: 'ok' | 'error';
  timestamp: string;
  checks: {
    postgres: 'up' | 'down';
    redis: 'up' | 'down';
  };
}

export function getHealth(): Promise<HealthCheckResponse> {
  return request<HealthCheckResponse>('/health');
}

export function login(identifier: string, password: string): Promise<AdminUser> {
  return request<AdminUser>('/admin/session/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
  });
}

export function fetchCurrentUser(): Promise<AdminUser> {
  return request<AdminUser>('/admin/session/me');
}

export async function logout(): Promise<void> {
  await request<void>('/admin/session/logout', { method: 'POST' }).catch(() => {
    // Best-effort — the local session is cleared by the caller regardless.
  });
}

// --- Financial admin visibility (Phase 3) ---
// All of these hit `/admin/...` routes, which the API guards with
// `JwtAuthGuard` + `RolesGuard` + `@Roles('ADMIN')` — the same primitives
// as every other authenticated route. This UI's own role check
// (`useAuth` rejecting non-admin logins) is defense in depth, not the
// real authorization boundary.

export function fetchWallet(userId: string): Promise<AdminWallet> {
  return request<AdminWallet>(`/admin/wallets/${userId}`);
}

export function fetchLedger(userId: string): Promise<CursorPage<AdminLedgerEntry>> {
  return request<CursorPage<AdminLedgerEntry>>(
    `/admin/ledger?userId=${encodeURIComponent(userId)}`,
  );
}

export function fetchDeposits(userId: string): Promise<CursorPage<AdminDeposit>> {
  return request<CursorPage<AdminDeposit>>(`/admin/deposits?userId=${encodeURIComponent(userId)}`);
}

export function listWithdrawals(status?: string): Promise<CursorPage<AdminWithdrawal>> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return request<CursorPage<AdminWithdrawal>>(`/admin/withdrawals${query}`);
}

export function approveWithdrawal(id: string, reason: string): Promise<AdminWithdrawal> {
  return request<AdminWithdrawal>(`/admin/withdrawals/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function rejectWithdrawal(id: string, reason: string): Promise<AdminWithdrawal> {
  return request<AdminWithdrawal>(`/admin/withdrawals/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function completeWithdrawal(id: string, reason: string): Promise<AdminWithdrawal> {
  return request<AdminWithdrawal>(`/admin/withdrawals/${id}/complete`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function failWithdrawal(id: string, reason: string): Promise<AdminWithdrawal> {
  return request<AdminWithdrawal>(`/admin/withdrawals/${id}/fail`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

// --- Match visibility (Phase 4) ---
// Read-only: there is no endpoint to set or override a match result. The
// server is the sole authority over outcomes (ADR-008).

export function listMatches(status?: string): Promise<CursorPage<AdminMatch>> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return request<CursorPage<AdminMatch>>(`/admin/matches${query}`);
}

export function fetchMatch(id: string): Promise<AdminMatch> {
  return request<AdminMatch>(`/admin/matches/${encodeURIComponent(id)}`);
}

// --- Match financial detail, disputes & reconciliation (Phase 5) ---
// Dispute resolution is status + audit only — `resolveDispute` never
// moves money. Any balance correction after upholding a dispute is a
// separate call to the existing `/admin/wallets/:userId/adjustments`
// endpoint, not something this module exposes as part of resolving.
// Reconciliation is read-only: running it never modifies any record.

export function fetchMatchFinancial(matchId: string): Promise<AdminMatchFinancial> {
  return request<AdminMatchFinancial>(`/admin/matches/${encodeURIComponent(matchId)}/financial`);
}

export function listDisputes(status?: string): Promise<CursorPage<AdminDispute>> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return request<CursorPage<AdminDispute>>(`/admin/disputes${query}`);
}

export function fetchDispute(id: string): Promise<AdminDispute> {
  return request<AdminDispute>(`/admin/disputes/${encodeURIComponent(id)}`);
}

export function resolveDispute(
  id: string,
  status: string,
  resolution: string,
): Promise<AdminDispute> {
  return request<AdminDispute>(`/admin/disputes/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ status, resolution }),
  });
}

export function runReconciliation(): Promise<ReconciliationReport> {
  return request<ReconciliationReport>('/admin/reconciliation/run');
}

// --- Responsible-gaming visibility (Phase 8) ---
// Read-only: there is no endpoint here to lift a restriction (including
// self-exclusion) or to alter rolling-window usage — see ADR-021/ADR-023.

export function listResponsibleGamingHistory(
  userId: string,
): Promise<AdminResponsibleGamingRestriction[]> {
  return request<AdminResponsibleGamingRestriction[]>(
    `/admin/responsible-gaming?userId=${encodeURIComponent(userId)}`,
  );
}

export function fetchResponsibleGamingUsage(userId: string): Promise<AdminResponsibleGamingUsage> {
  return request<AdminResponsibleGamingUsage>(
    `/admin/responsible-gaming/${encodeURIComponent(userId)}/usage`,
  );
}
