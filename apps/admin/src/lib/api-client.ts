import type { ApiErrorResponse } from '@playle/shared';
import { appConfig } from './config';

/**
 * API client abstraction. Admin UI code calls functions from this module
 * rather than using `fetch` directly, so the base URL, error handling, and
 * (in a later phase) auth-header attachment stay in one place.
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${appConfig.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    const message = Array.isArray(body?.message)
      ? body.message.join(', ')
      : (body?.message ?? response.statusText);
    throw new ApiRequestError(message, response.status);
  }

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
