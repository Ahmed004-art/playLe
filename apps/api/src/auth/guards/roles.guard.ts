import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import type { AuthenticatedRequest } from './jwt-auth.guard.js';

/**
 * Enforces `@Roles(...)`. Must run after `JwtAuthGuard` — it reads
 * `request.user`, which only `JwtAuthGuard` sets. A route with no
 * `@Roles()` decorator is allowed through (authentication alone is
 * sufficient); this guard only restricts, never grants, access.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<
      UserRole[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException('Insufficient role for this operation');
    }

    return true;
  }
}
