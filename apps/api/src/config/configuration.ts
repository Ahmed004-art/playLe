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
  adminSession: {
    /**
     * `Secure` on cookies and `SameSite=None` (vs. `Lax`) — only ever
     * true in a real deployed (HTTPS) environment. Never true in local
     * dev/test, where cookies must work over plain HTTP.
     */
    secureCookies: boolean;
    accessTokenCookieTtlMs: number;
  };
  security: {
    /** 64-hex-char (32-byte) key encrypting MFA TOTP secrets at rest (AES-256-GCM). */
    mfaEncryptionKey: string;
  };
  notifications: {
    dispatchSweepIntervalMs: number;
  };
  payments: {
    provider: 'manual' | 'monime';
    monimeApiKey?: string;
    monimeSpaceId?: string;
    monimeWebhookSecret?: string;
    monimeBaseUrl: string;
    /** Optional `Monime-Version` header pin, e.g. `caph.2025-08-23`. */
    monimeApiVersion?: string;
    monimeHttpTimeoutMs: number;
    /**
     * Separate from merely selecting `provider: 'monime'` or having an
     * API key configured — a *live* (non-`mon_test_`) Monime token is
     * never actually used to make a real HTTP call unless this is also
     * explicitly `true`. A test-prefixed token is always allowed to run
     * (see docs/development/PHASE_6_CHECKLIST.md, "production activation
     * guardrails" — no single flag enables every capability at once).
     */
    monimeLivePaymentsEnabled: boolean;
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
    /**
     * How long a draw offer (Phase 9 — ADR-024) stays open before it's
     * treated as expired. A platform-level UX concern, not a game rule
     * — unlike the turn clock, this is one global config value, not a
     * per-game catalog column.
     */
    drawOfferTimeoutMs: number;
  };
  stakes: {
    /**
     * Master real-money gate. Defaults to `false` — the system never
     * enters real-money mode because an environment variable is merely
     * missing; it must be explicitly turned on (see
     * docs/decisions/ADR-016-match-financial-architecture.md,
     * "production activation boundary").
     */
    realMoneyGamingEnabled: boolean;
    /**
     * A second, independent gate from `realMoneyGamingEnabled` — see
     * ADR-021. The owner's age/jurisdiction/KYC policy is a legal
     * decision this codebase cannot make; real-money gaming never runs
     * unless *both* flags are true, so flipping one alone (e.g. by
     * accident) can never silently enable live play with no configured
     * legal policy behind it.
     */
    eligibilityPolicyConfigured: boolean;
    /**
     * Deliberately separate from `auth.minAgeYears` (the general account
     * age gate) — see ADR-016, "real-money eligibility is not identity
     * eligibility".
     */
    realMoneyMinimumAge: number;
    minStakeMinor: bigint;
    maxStakeMinor: bigint;
    platformFeePercent: number;
    stakeCommitTimeoutMs: number;
    throttleLimit: number;
    throttleTtlMs: number;
  };
  responsibleGaming: {
    /**
     * Fixed, non-user-configurable rolling-window length (hours) for
     * STAKE_LIMIT/LOSS_LIMIT/DEPOSIT_LIMIT enforcement — see
     * docs/decisions/ADR-023-rolling-window-responsible-gaming.md.
     */
    windowHours: number;
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
  adminSession: {
    secureCookies: process.env.ADMIN_SESSION_SECURE_COOKIES === 'true',
    // Keep in sync with JWT_ACCESS_TTL's default (15m) unless changed.
    accessTokenCookieTtlMs: parseInt(
      process.env.ADMIN_SESSION_ACCESS_COOKIE_TTL_MS ?? '900000',
      10,
    ),
  },
  security: {
    mfaEncryptionKey: process.env.MFA_ENCRYPTION_KEY ?? '',
  },
  notifications: {
    dispatchSweepIntervalMs: parseInt(
      process.env.NOTIFICATION_DISPATCH_SWEEP_INTERVAL_MS ?? '10000',
      10,
    ),
  },
  payments: {
    provider: process.env.PAYMENTS_PROVIDER === 'monime' ? 'monime' : 'manual',
    monimeApiKey: process.env.MONIME_API_KEY || undefined,
    monimeSpaceId: process.env.MONIME_SPACE_ID || undefined,
    monimeWebhookSecret: process.env.MONIME_WEBHOOK_SECRET || undefined,
    monimeBaseUrl: process.env.MONIME_BASE_URL ?? 'https://api.monime.io',
    monimeApiVersion: process.env.MONIME_API_VERSION || undefined,
    monimeHttpTimeoutMs: parseInt(
      process.env.MONIME_HTTP_TIMEOUT_MS ?? '10000',
      10,
    ),
    monimeLivePaymentsEnabled:
      process.env.MONIME_LIVE_PAYMENTS_ENABLED === 'true',
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
    drawOfferTimeoutMs: parseInt(
      process.env.MATCH_DRAW_OFFER_TIMEOUT_MS ?? '60000',
      10,
    ),
  },
  stakes: {
    realMoneyGamingEnabled: process.env.REAL_MONEY_GAMING_ENABLED === 'true',
    eligibilityPolicyConfigured:
      process.env.ELIGIBILITY_POLICY_CONFIGURED === 'true',
    realMoneyMinimumAge: parseInt(
      process.env.REAL_MONEY_MINIMUM_AGE ?? '18',
      10,
    ),
    minStakeMinor: BigInt(process.env.MINIMUM_STAKE_MINOR ?? '100'),
    maxStakeMinor: BigInt(process.env.MAXIMUM_STAKE_MINOR ?? '1000000'),
    platformFeePercent: parseInt(
      process.env.PLATFORM_FEE_PERCENTAGE ?? '10',
      10,
    ),
    stakeCommitTimeoutMs: parseInt(
      process.env.STAKE_COMMIT_TIMEOUT_MS ?? '60000',
      10,
    ),
    throttleLimit: parseInt(process.env.STAKES_THROTTLE_LIMIT ?? '30', 10),
    throttleTtlMs: parseInt(process.env.STAKES_THROTTLE_TTL_MS ?? '60000', 10),
  },
  responsibleGaming: {
    windowHours: parseInt(
      process.env.RESPONSIBLE_GAMING_WINDOW_HOURS ?? '24',
      10,
    ),
  },
});
