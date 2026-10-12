import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuditService } from '../audit/admin-audit.service.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Double-submit CSRF protection for the admin surface. Browsers attach
 * cookies automatically to cross-site requests, which is exactly what
 * makes cookie-based auth vulnerable to CSRF — so every mutating
 * `/admin/*` request made with the httpOnly session cookie (rather than
 * an `Authorization` header) must also echo the non-httpOnly
 * `admin_csrf_token` cookie value back in an `X-CSRF-Token` header. A
 * request authenticated via `Authorization: Bearer <token>` is not
 * cookie-driven and is therefore not CSRF-exploitable — this guard is a
 * no-op for it, so every existing Bearer-token-based admin client/test
 * is unaffected.
 *
 * Registered globally (`APP_GUARD` in `app.module.ts`) rather than
 * per-controller so it automatically covers every current and future
 * `/admin/*` route without each one needing to remember to add it.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly auditService: AdminAuditService) {}

  canActivate(context: ExecutionContext): boolean {
    // Registered globally, this guard also runs for non-HTTP contexts
    // (WebSocket message handlers in `RealtimeGateway`) — CSRF is an
    // HTTP-cookie concept and meaningless there, so it must no-op rather
    // than call `switchToHttp()` (which, outside a real HTTP context,
    // does not return a real Express `Request` and would throw on
    // `request.path`).
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<Request>();

    if (!request.path.startsWith('/api/v1/admin')) return true;
    if (!MUTATING_METHODS.has(request.method)) return true;
    if (request.headers.authorization) return true;
    // No session cookie exists yet before the user has logged in.
    if (request.path === '/api/v1/admin/session/login') return true;

    const cookies: unknown = request.cookies;
    const cookieToken =
      cookies && typeof cookies === 'object'
        ? (cookies as Record<string, unknown>).admin_csrf_token
        : undefined;
    const headers = request.headers as Record<string, unknown>;
    const headerToken = this.firstHeaderValue(headers['x-csrf-token']);
    const userAgent = this.firstHeaderValue(headers['user-agent']);
    const ipAddress: string | undefined = request.ip;

    if (
      typeof cookieToken !== 'string' ||
      !headerToken ||
      cookieToken !== headerToken
    ) {
      void this.auditService.record('CSRF_REJECTED', {
        detail: `${request.method} ${request.path}`,
        ipAddress,
        userAgent,
      });
      throw new ForbiddenException('Missing or invalid CSRF token');
    }

    return true;
  }

  private firstHeaderValue(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return undefined;
  }
}
