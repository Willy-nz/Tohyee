import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238, the codes authenticator apps show):
 * HMAC-SHA1, 6 digits, a new code every 30 seconds. Codes from one step
 * either side of now are accepted, to allow for a phone clock that's a little
 * off. Pure functions, no database.
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
const WINDOW = 1;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Not base32.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** A new random secret (160 bits, as RFC 4226 recommends), base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function currentStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for one time step. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Just the digits someone typed ("123 456" is fine), or null if it isn't a 6-digit code. */
export function normaliseTotpInput(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

/**
 * The time step a code belongs to, or null if it doesn't match. A step at or
 * before `lastUsedStep` is refused, so a code can't be used twice.
 */
export function matchTotp(
  secret: string,
  input: string,
  options: { nowMs?: number; lastUsedStep?: number | null } = {},
): number | null {
  const code = normaliseTotpInput(input);
  if (!code) return null;
  const now = currentStep(options.nowMs);
  for (let offset = -WINDOW; offset <= WINDOW; offset += 1) {
    const step = now + offset;
    if (options.lastUsedStep != null && step <= options.lastUsedStep) continue;
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

/** The otpauth:// link an authenticator app reads from the QR code. */
export function otpauthUri(issuer: string, account: string, secret: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Ten one-use backup codes like "k7fq2-mx9ta" (50 random bits each). */
export function generateBackupCodes(count = 10): string[] {
  const lower = "abcdefghijkmnpqrstuvwxyz23456789";
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    const chars = Array.from(bytes, (byte) => lower[byte & 31]).join("");
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

/** A backup code as typed, lower-cased without spaces, or null if it can't be one. */
export function normaliseBackupCode(input: string): string | null {
  const clean = input.trim().toLowerCase().replace(/\s/g, "");
  const match = /^([a-z0-9]{5})-?([a-z0-9]{5})$/.exec(clean);
  return match ? `${match[1]}-${match[2]}` : null;
}
