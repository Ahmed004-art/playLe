import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '@prisma/client';
import { TokenService } from '../token.service.js';
import { UsersService } from '../../users/users.service.js';

export interface AuthenticatedRequest extends Request {
  user: User;
}

/**
 * Verifies the `Authorization: Bearer <token>` access token and attaches
 * the full, current user record to the request. Re-reading the user
 * (rather than trusting the JWT payload alone) means a status change
 * (e.g. SUSPENDED) takes effect on the very next request, not only after
 * the access token expires.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }

    const payload = this.tokenService.verifyAccessToken(token);
    const user = await this.usersService.findById(payload.sub);

    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }

    request.user = user;
    return true;
  }

  private extractToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;

    const [scheme, token] = header.split(' ');
    return scheme === 'Bearer' ? token : undefined;
  }
}
