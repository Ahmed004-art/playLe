/**
 * Environment configuration for the admin app. `NEXT_PUBLIC_*` variables
 * are inlined at build time by Next.js — never put secrets here, only
 * public, non-sensitive configuration (see docs/architecture/SECURITY.md).
 */
export const appConfig = {
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000/api/v1',
};
