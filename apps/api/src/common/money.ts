/**
 * Money is always an integer count of minor units (1 SLE = 100 minor
 * units) and always a `bigint` in code, never a float — see
 * docs/decisions/ADR-012-financial-architecture.md. The wire format is a
 * decimal string of that integer, because neither JSON nor JS/Dart
 * `number` can safely round-trip an arbitrary-size integer or a `bigint`.
 */

const MINOR_UNITS_PATTERN = /^\d+$/;

/** Converts a validated minor-units string (from a request DTO) to `bigint`. */
export function parseAmountMinor(value: string): bigint {
  if (!MINOR_UNITS_PATTERN.test(value)) {
    throw new Error(
      `Invalid amount: expected a non-negative integer string of minor units, got "${value}"`,
    );
  }
  return BigInt(value);
}

/** Converts a `bigint` minor-units value to its wire (string) representation. */
export function toAmountString(value: bigint): string {
  return value.toString();
}

/** `true` if `value` parses as a minor-units string (used by DTO validators). */
export function isAmountMinorString(value: unknown): boolean {
  return typeof value === 'string' && MINOR_UNITS_PATTERN.test(value);
}
