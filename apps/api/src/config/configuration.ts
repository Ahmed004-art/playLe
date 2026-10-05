/**
 * Typed configuration factory consumed via `ConfigService.get<T>(...)`.
 * Keep this the single place that reads `process.env` — everything else
 * should depend on `ConfigService`, not `process.env` directly.
 */
export interface AppConfiguration {
  env: string;
  port: number;
  corsOrigins: string[];
  database: {
    url: string;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
  };
  throttle: {
    ttlMs: number;
    limit: number;
  };
  auth: {
    accessTokenSecret: string;
    accessTokenTtl: string;
    refreshTokenTtlDays: number;
    minAgeYears: number;
    throttleLimit: number;
    throttleTtlMs: number;
  };
  payments: {
    provider: 'manual' | 'monime';
    monimeApiKey?: string;
    monimeWebhookSecret?: string;
    minDepositMinor: bigint;
    minWithdrawalMinor: bigint;
    throttleLimit: number;
    throttleTtlMs: number;
  };
  matches: {
    throttleLimit: number;
    throttleTtlMs: number;
    challengeExpiryMs: number;
    abandonGraceMs: number;
    timeoutSweepIntervalMs: number;
  };
}

export default (): AppConfiguration => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  throttle: {
    ttlMs: parseInt(process.env.THROTTLE_TTL_MS ?? '60000', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  },
  auth: {
    accessTokenSecret: process.env.JWT_ACCESS_SECRET ?? '',
    accessTokenTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTokenTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS ?? '30', 10),
    minAgeYears: parseInt(process.env.AUTH_MIN_AGE_YEARS ?? '16', 10),
    throttleLimit: parseInt(process.env.AUTH_THROTTLE_LIMIT ?? '5', 10),
    throttleTtlMs: parseInt(process.env.AUTH_THROTTLE_TTL_MS ?? '60000', 10),
  },
  payments: {
    provider: process.env.PAYMENTS_PROVIDER === 'monime' ? 'monime' : 'manual',
    monimeApiKey: process.env.MONIME_API_KEY || undefined,
    monimeWebhookSecret: process.env.MONIME_WEBHOOK_SECRET || undefined,
    minDepositMinor: BigInt(process.env.WALLET_MIN_DEPOSIT_MINOR ?? '500'),
    minWithdrawalMinor: BigInt(
      process.env.WALLET_MIN_WITHDRAWAL_MINOR ?? '500',
    ),
    throttleLimit: parseInt(process.env.PAYMENTS_THROTTLE_LIMIT ?? '10', 10),
    throttleTtlMs: parseInt(
      process.env.PAYMENTS_THROTTLE_TTL_MS ?? '60000',
      10,
    ),
  },
  matches: {
    throttleLimit: parseInt(process.env.MATCHES_THROTTLE_LIMIT ?? '30', 10),
    throttleTtlMs: parseInt(process.env.MATCHES_THROTTLE_TTL_MS ?? '60000', 10),
    challengeExpiryMs: parseInt(
      process.env.CHALLENGE_EXPIRY_MS ?? '120000',
      10,
    ),
    abandonGraceMs: parseInt(process.env.MATCH_ABANDON_GRACE_MS ?? '30000', 10),
    timeoutSweepIntervalMs: parseInt(
      process.env.MATCH_TIMEOUT_SWEEP_INTERVAL_MS ?? '10000',
      10,
    ),
  },
});
