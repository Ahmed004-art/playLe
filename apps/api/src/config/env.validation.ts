import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Declares every environment variable the API requires and its shape. The
 * API refuses to boot if this fails validation (see main.ts bootstrap),
 * so a misconfigured deployment fails fast instead of running with
 * silently wrong settings.
 */
class EnvironmentVariables {
  @IsIn(['development', 'test', 'staging', 'production'])
  NODE_ENV: string = 'development';

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  REDIS_HOST: string = 'localhost';

  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT: number = 6379;

  @IsOptional()
  @IsString()
  REDIS_PASSWORD?: string;

  @IsOptional()
  @IsString()
  CORS_ORIGINS: string = 'http://localhost:3001';

  @IsInt()
  @Min(1)
  THROTTLE_TTL_MS: number = 60000;

  @IsInt()
  @Min(1)
  THROTTLE_LIMIT: number = 100;

  @IsString()
  @MinLength(32, {
    message: 'JWT_ACCESS_SECRET must be at least 32 characters long',
  })
  JWT_ACCESS_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_ACCESS_TTL: string = '15m';

  @IsInt()
  @Min(1)
  JWT_REFRESH_TTL_DAYS: number = 30;

  @IsInt()
  @Min(13)
  @Max(99)
  AUTH_MIN_AGE_YEARS: number = 16;

  @IsInt()
  @Min(1)
  AUTH_THROTTLE_LIMIT: number = 5;

  @IsInt()
  @Min(1)
  AUTH_THROTTLE_TTL_MS: number = 60000;

  @IsString()
  @MinLength(64, {
    message:
      "MFA_ENCRYPTION_KEY must be a 64-character hex string (32 bytes) — generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  })
  MFA_ENCRYPTION_KEY!: string;

  @IsIn(['manual', 'monime'])
  PAYMENTS_PROVIDER: string = 'manual';

  @IsOptional()
  @IsString()
  MONIME_API_KEY?: string;

  @IsOptional()
  @IsString()
  MONIME_WEBHOOK_SECRET?: string;

  @IsInt()
  @Min(1)
  WALLET_MIN_DEPOSIT_MINOR: number = 500;

  @IsInt()
  @Min(1)
  WALLET_MIN_WITHDRAWAL_MINOR: number = 500;

  @IsInt()
  @Min(1)
  PAYMENTS_THROTTLE_LIMIT: number = 10;

  @IsInt()
  @Min(1)
  PAYMENTS_THROTTLE_TTL_MS: number = 60000;

  @IsInt()
  @Min(1)
  MATCHES_THROTTLE_LIMIT: number = 30;

  @IsInt()
  @Min(1)
  MATCHES_THROTTLE_TTL_MS: number = 60000;

  @IsInt()
  @Min(1)
  CHALLENGE_EXPIRY_MS: number = 120000;

  @IsInt()
  @Min(1)
  MATCH_ABANDON_GRACE_MS: number = 30000;

  @IsInt()
  @Min(1)
  MATCH_TIMEOUT_SWEEP_INTERVAL_MS: number = 10000;

  // Phase 9 — see docs/decisions/ADR-024-match-lifecycle-integrity.md.
  // The turn clock itself is a per-game Game.turnTimeoutSeconds catalog
  // value, not an env var — only the draw-offer window (a platform UX
  // concern, not a game rule) is configured here.
  @IsInt()
  @Min(1)
  MATCH_DRAW_OFFER_TIMEOUT_MS: number = 60000;

  // Phase 5 — see docs/decisions/ADR-016-match-financial-architecture.md.
  // Defaults are all safe-off/conservative — real-money gaming never turns
  // on because a variable is merely unset.

  @IsIn(['true', 'false'])
  REAL_MONEY_GAMING_ENABLED: string = 'false';

  @IsIn(['true', 'false'])
  ELIGIBILITY_POLICY_CONFIGURED: string = 'false';

  @IsInt()
  @Min(13)
  @Max(99)
  REAL_MONEY_MINIMUM_AGE: number = 18;

  @IsInt()
  @Min(1)
  MINIMUM_STAKE_MINOR: number = 100;

  @IsInt()
  @Min(1)
  MAXIMUM_STAKE_MINOR: number = 1000000;

  @IsInt()
  @Min(0)
  @Max(100)
  PLATFORM_FEE_PERCENTAGE: number = 10;

  @IsInt()
  @Min(1)
  STAKE_COMMIT_TIMEOUT_MS: number = 60000;

  @IsInt()
  @Min(1)
  STAKES_THROTTLE_LIMIT: number = 30;

  @IsInt()
  @Min(1)
  STAKES_THROTTLE_TTL_MS: number = 60000;

  /**
   * The rolling-window length for STAKE_LIMIT/LOSS_LIMIT/DEPOSIT_LIMIT
   * enforcement (Phase 8) — deliberately a fixed platform parameter, not
   * user-configurable, so a user cannot evade their own limit by
   * shortening the window right before a large stake. See
   * docs/decisions/ADR-023-rolling-window-responsible-gaming.md.
   */
  @IsInt()
  @Min(1)
  @Max(24 * 90)
  RESPONSIBLE_GAMING_WINDOW_HOURS: number = 24;
}

export function validate(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Environment validation failed: ${details}`);
  }

  return validated;
}
