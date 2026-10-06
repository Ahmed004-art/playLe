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

  // Phase 5 — see docs/decisions/ADR-016-match-financial-architecture.md.
  // Defaults are all safe-off/conservative — real-money gaming never turns
  // on because a variable is merely unset.

  @IsIn(['true', 'false'])
  REAL_MONEY_GAMING_ENABLED: string = 'false';

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
