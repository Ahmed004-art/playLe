import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Phone number normalization. Defaults to Sierra Leone (SL) when a number
 * is given without an explicit country code, matching PlayLe's initial
 * market (see ADR-010), but accepts any valid E.164-parseable number so
 * the system doesn't hard-code against ever supporting other countries —
 * a number given with its own country code (e.g. "+44...") normalizes
 * correctly regardless of the default region.
 *
 * Returns the canonical E.164 form (e.g. "+23276000000"), or null if the
 * input isn't a valid phone number.
 */
export function normalizePhoneNumber(raw: string): string | null {
  const phoneNumber = parsePhoneNumberFromString(raw, 'SL');

  if (!phoneNumber || !phoneNumber.isValid()) {
    return null;
  }

  return phoneNumber.number;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
