/**
 * Formats a decimal string of integer minor units as a display string
 * (e.g. `"50000"` -> `"Le 500.00"`). Uses `BigInt` throughout — never a
 * `number` — matching the mobile app's `formatMinorAmount` and the
 * server's own representation (see
 * docs/decisions/ADR-012-financial-architecture.md).
 */
export function formatMinorAmount(minorUnitsString: string, currency = 'SLE'): string {
  const hundred = BigInt(100);
  const zero = BigInt(0);
  const minor = BigInt(minorUnitsString);
  const isNegative = minor < zero;
  const abs = isNegative ? -minor : minor;
  const major = abs / hundred;
  const cents = (abs % hundred).toString().padStart(2, '0');
  const symbol = currency === 'SLE' ? 'Le' : currency;
  return `${isNegative ? '-' : ''}${symbol} ${major}.${cents}`;
}
