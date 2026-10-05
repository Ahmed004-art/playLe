import type { ApiErrorResponse } from '@playle/shared';
import { appConfig } from './config';
import { tokenStorage } from './token-storage';
import type { AdminUser, AuthResponse } from './auth-types';

/**
 * API client abstraction. Admin UI code calls functions from this module
 * rather than using `fetch` directly, so the base URL, error handling, and
 * auth-header attachment stay in one place.
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

async function request<T>(path: string, init?: RequestInit, auth = false): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };

  if (auth) {
    const token = tokenStorage.getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${appConfig.apiBaseUrl}${path}`, { ...init, headers });

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

export function login(identifier: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
  });
}

export function fetchCurrentUser(): Promise<AdminUser> {
  return request<AdminUser>('/auth/me', {}, true);
}

export async function logout(): Promise<void> {
  const refreshToken = tokenStorage.getRefreshToken();
  if (!refreshToken) return;
  await request<void>(
    '/auth/logout',
    { method: 'POST', body: JSON.stringify({ refreshToken }) },
    true,
  ).catch(() => {
    // Best-effort — the local session is cleared by the caller regardless.
  });
}
