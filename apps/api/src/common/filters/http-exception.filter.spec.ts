import {
  ArgumentsHost,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { GlobalExceptionFilter } from './http-exception.filter.js';

function createHost(url: string) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const getResponse = vi.fn().mockReturnValue({ status });
  const getRequest = vi.fn().mockReturnValue({ url, method: 'GET' });

  const host = {
    switchToHttp: () => ({ getResponse, getRequest }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

describe('GlobalExceptionFilter', () => {
  it('normalizes a NestJS HttpException into the standard error shape', () => {
    const filter = new GlobalExceptionFilter();
    const { host, status, json } = createHost('/api/v1/example');

    filter.catch(new NotFoundException('Resource not found'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Resource not found',
        path: '/api/v1/example',
      }),
    );
  });

  it('preserves class-validator message arrays', () => {
    const filter = new GlobalExceptionFilter();
    const { host, json } = createHost('/api/v1/example');

    filter.catch(new BadRequestException(['field must not be empty']), host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: ['field must not be empty'] }),
    );
  });

  it('never leaks internal details for unexpected errors', () => {
    const filter = new GlobalExceptionFilter();
    const { host, status, json } = createHost('/api/v1/example');

    filter.catch(new Error('database connection string leaked'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Internal server error' }),
    );
  });
});
