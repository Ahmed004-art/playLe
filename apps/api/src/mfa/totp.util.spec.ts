import { describe, expect, it } from 'vitest';
import {
  buildTotpUri,
  encodeBase32,
  generateBase32Secret,
  generateTotp,
  verifyTotp,
} from './totp.util.js';

describe('TOTP (RFC 6238) — hand-rolled implementation', () => {
  it('matches the official RFC 6238 SHA-1 test vector', () => {
    // RFC 6238 Appendix B: secret "12345678901234567890" (ASCII),
    // T=59s → counter 1 → expected code "94287082" at 8 digits.
    const secret = encodeBase32(Buffer.from('12345678901234567890', 'ascii'));
    const code = generateTotp(secret, { digits: 8, nowMs: 59 * 1000 });
    expect(code).toBe('94287082');
  });

  it('generates a verifiable 6-digit code by default', () => {
    const secret = generateBase32Secret();
    const code = generateTotp(secret);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(secret, code)).toBe(true);
  });

  it('rejects a code from a different secret', () => {
    const secretA = generateBase32Secret();
    const secretB = generateBase32Secret();
    const code = generateTotp(secretA);
    expect(verifyTotp(secretB, code)).toBe(false);
  });

  it('tolerates one time-step of clock drift', () => {
    const secret = generateBase32Secret();
    const now = Date.now();
    const previousStepCode = generateTotp(secret, { nowMs: now - 30_000 });
    expect(verifyTotp(secret, previousStepCode, { nowMs: now })).toBe(true);
  });

  it('rejects a code two time-steps away', () => {
    const secret = generateBase32Secret();
    const now = Date.now();
    const staleCode = generateTotp(secret, { nowMs: now - 90_000 });
    expect(verifyTotp(secret, staleCode, { nowMs: now })).toBe(false);
  });

  it('builds a well-formed otpauth:// URI', () => {
    const uri = buildTotpUri({
      secret: 'ABCDEFGH',
      accountName: 'player@example.com',
      issuer: 'PlayLe',
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('secret=ABCDEFGH');
    expect(uri).toContain('issuer=PlayLe');
  });
});
