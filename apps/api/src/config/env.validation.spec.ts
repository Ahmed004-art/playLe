import { describe, expect, it } from 'vitest';
import { validate } from './env.validation.js';

describe('validate (environment variables)', () => {
  const validEnv = {
    NODE_ENV: 'development',
    PORT: '3000',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    CORS_ORIGINS: 'http://localhost:3001',
    THROTTLE_TTL_MS: '60000',
    THROTTLE_LIMIT: '100',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL_DAYS: '30',
    AUTH_MIN_AGE_YEARS: '16',
  };

  it('accepts a fully valid environment', () => {
    expect(() => validate(validEnv)).not.toThrow();
  });

  it('applies defaults for optional fields', () => {
    const { NODE_ENV: _NODE_ENV, PORT: _PORT, ...rest } = validEnv;
    const result = validate(rest);

    expect(result.NODE_ENV).toBe('development');
    expect(result.PORT).toBe(3000);
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL: _DATABASE_URL, ...invalidEnv } = validEnv;

    expect(() => validate(invalidEnv)).toThrow(/Environment validation failed/);
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() =>
      validate({ ...validEnv, NODE_ENV: 'not-a-real-env' }),
    ).toThrow();
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => validate({ ...validEnv, PORT: '99999' })).toThrow();
  });

  it('rejects a JWT_ACCESS_SECRET shorter than 32 characters', () => {
    expect(() =>
      validate({ ...validEnv, JWT_ACCESS_SECRET: 'too-short' }),
    ).toThrow();
  });

  it('defaults PAYMENTS_PROVIDER to manual', () => {
    const result = validate(validEnv);
    expect(result.PAYMENTS_PROVIDER).toBe('manual');
  });

  it('rejects an unknown PAYMENTS_PROVIDER', () => {
    expect(() =>
      validate({ ...validEnv, PAYMENTS_PROVIDER: 'stripe' }),
    ).toThrow();
  });

  it('accepts monime as a PAYMENTS_PROVIDER value', () => {
    expect(() =>
      validate({ ...validEnv, PAYMENTS_PROVIDER: 'monime' }),
    ).not.toThrow();
  });
});
