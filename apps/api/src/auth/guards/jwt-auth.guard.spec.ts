import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { TokenService } from '../token.service.js';
import { UsersService } from '../../users/users.service.js';

function contextWithHeader(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let tokenService: { verifyAccessToken: ReturnType<typeof vi.fn> };
  let usersService: { findById: ReturnType<typeof vi.fn> };
  let guard: JwtAuthGuard;

  beforeEach(() => {
    tokenService = { verifyAccessToken: vi.fn() };
    usersService = { findById: vi.fn() };
    guard = new JwtAuthGuard(
      tokenService as unknown as TokenService,
      usersService as unknown as UsersService,
    );
  });

  it('rejects a request with no Authorization header', async () => {
    await expect(
      guard.canActivate(contextWithHeader(undefined)),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a non-Bearer Authorization header', async () => {
    await expect(
      guard.canActivate(contextWithHeader('Basic abc123')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when the token belongs to a user that no longer exists', async () => {
    tokenService.verifyAccessToken.mockReturnValue({
      sub: 'ghost',
      role: 'USER',
    });
    usersService.findById.mockResolvedValue(null);

    await expect(
      guard.canActivate(contextWithHeader('Bearer token')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when the user is not ACTIVE', async () => {
    tokenService.verifyAccessToken.mockReturnValue({
      sub: 'user-1',
      role: 'USER',
    });
    usersService.findById.mockResolvedValue({
      id: 'user-1',
      status: 'SUSPENDED',
    });

    await expect(
      guard.canActivate(contextWithHeader('Bearer token')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('attaches the user to the request and allows an active user through', async () => {
    const user = { id: 'user-1', status: 'ACTIVE', role: 'USER' };
    tokenService.verifyAccessToken.mockReturnValue({
      sub: 'user-1',
      role: 'USER',
    });
    usersService.findById.mockResolvedValue(user);

    const request: { user?: unknown; headers: Record<string, string> } = {
      headers: { authorization: 'Bearer token' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBe(user);
  });
});
