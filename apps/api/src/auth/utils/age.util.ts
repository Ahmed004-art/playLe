/**
 * Server-side age calculation for the registration age gate. Never trust
 * an age value sent by the client — only `dateOfBirth` is accepted, and
 * the age is always computed here, server-side, at the moment of
 * registration. See ADR-011 — this is a product age gate, not KYC/legal
 * age verification.
 */
export function calculateAge(
  dateOfBirth: Date,
  asOf: Date = new Date(),
): number {
  let age = asOf.getFullYear() - dateOfBirth.getFullYear();
  const monthDiff = asOf.getMonth() - dateOfBirth.getMonth();
  const dayDiff = asOf.getDate() - dateOfBirth.getDate();

  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age -= 1;
  }

  return age;
}

export function isOldEnough(
  dateOfBirth: Date,
  minAgeYears: number,
  asOf: Date = new Date(),
): boolean {
  return calculateAge(dateOfBirth, asOf) >= minAgeYears;
}
