import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizePhoneNumber } from './phone.util.js';

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Player@Example.COM  ')).toBe('player@example.com');
  });
});

describe('normalizePhoneNumber', () => {
  it('normalizes a Sierra Leone number given without a country code', () => {
    const result = normalizePhoneNumber('076000000');
    expect(result).toMatch(/^\+232/);
  });

  it('normalizes a number already given with an explicit country code', () => {
    const result = normalizePhoneNumber('+447911123456');
    expect(result).toBe('+447911123456');
  });

  it('returns null for an invalid number', () => {
    expect(normalizePhoneNumber('not-a-phone-number')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(normalizePhoneNumber('')).toBeNull();
  });
});
