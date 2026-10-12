import { createHmac, randomBytes } from 'node:crypto';

/**
 * A from-scratch, dependency-free implementation of HOTP (RFC 4226) and
 * TOTP (RFC 6238) — deliberately hand-rolled rather than adding a new
 * npm dependency (`otplib`/`speakeasy` etc.) for what is a well-defined,
 * compact algorithm (see CLAUDE.md "avoid unnecessary dependencies").
 * Compatible with any standard authenticator app (Google
 * Authenticator, Authy, 1Password, etc.) using the default SHA-1/6-digit/
 * 30-second parameters.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD_SECONDS = 30;

export function generateBase32Secret(byteLength = 20): string {
  return encodeBase32(randomBytes(byteLength));
}

export function encodeBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function decodeBase32(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: bigint, digits: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);

  const hmac = createHmac('sha1', secret).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = (binary % 10 ** digits).toString().padStart(digits, '0');
  return otp;
}

export interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
  /** Unix timestamp in ms — overridable for deterministic tests. */
  nowMs?: number;
}

export function generateTotp(
  base32Secret: string,
  options: TotpOptions = {},
): string {
  const digits = options.digits ?? DEFAULT_DIGITS;
  const period = options.periodSeconds ?? DEFAULT_PERIOD_SECONDS;
  const counter = BigInt(
    Math.floor((options.nowMs ?? Date.now()) / 1000 / period),
  );
  return hotp(decodeBase32(base32Secret), counter, digits);
}

/**
 * Verifies a user-submitted TOTP code, tolerating one step of clock
 * drift in either direction (a standard, widely-adopted allowance for
 * TOTP verification).
 */
export function verifyTotp(
  base32Secret: string,
  code: string,
  options: TotpOptions = {},
): boolean {
  const digits = options.digits ?? DEFAULT_DIGITS;
  const period = options.periodSeconds ?? DEFAULT_PERIOD_SECONDS;
  const now = options.nowMs ?? Date.now();
  const normalized = code.trim();

  for (const drift of [-1, 0, 1]) {
    const candidate = generateTotp(base32Secret, {
      digits,
      periodSeconds: period,
      nowMs: now + drift * period * 1000,
    });
    if (candidate === normalized) return true;
  }
  return false;
}

/** `otpauth://` URI for QR-code enrollment, per Google Authenticator's de facto standard. */
export function buildTotpUri(params: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountName}`);
  const issuer = encodeURIComponent(params.issuer);
  return `otpauth://totp/${label}?secret=${params.secret}&issuer=${issuer}&algorithm=SHA1&digits=${DEFAULT_DIGITS}&period=${DEFAULT_PERIOD_SECONDS}`;
}
