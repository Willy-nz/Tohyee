import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateBackupCodes,
  generateTotpSecret,
  matchTotp,
  normaliseBackupCode,
  otpauthUri,
  totpCode,
} from "@/lib/auth/totp";

// RFC 6238 appendix B: the SHA-1 secret is the ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("authenticator codes (RFC 6238)", () => {
  it("matches the RFC test vectors (last 6 of the 8 digits)", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(totpCode(RFC_SECRET, Math.floor(59 / 30))).toBe("287082");
    expect(totpCode(RFC_SECRET, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpCode(RFC_SECRET, Math.floor(1234567890 / 30))).toBe("005924");
    expect(totpCode(RFC_SECRET, Math.floor(2000000000 / 30))).toBe("279037");
  });

  it("base32 round-trips", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
  });

  it("accepts the code one step either side, and never a step already used", () => {
    const now = 1_790_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step), { nowMs: now })).toBe(step);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), { nowMs: now })).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), { nowMs: now })).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), { nowMs: now })).toBeNull();
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step), { nowMs: now, lastUsedStep: step })).toBeNull();
    expect(matchTotp(RFC_SECRET, "12345", { nowMs: now })).toBeNull();
    const spaced = totpCode(RFC_SECRET, step);
    expect(matchTotp(RFC_SECRET, `${spaced.slice(0, 3)} ${spaced.slice(3)}`, { nowMs: now })).toBe(step);
  });

  it("builds the otpauth link authenticator apps read", () => {
    expect(otpauthUri("Tohyee", "jess@example.com", "ABC")).toBe(
      "otpauth://totp/Tohyee:jess%40example.com?secret=ABC&issuer=Tohyee&algorithm=SHA1&digits=6&period=30",
    );
  });

  it("makes 10 distinct backup codes and reads them however they're typed", () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(normaliseBackupCode(" K7FQ2 MX9TA ")).toBe("k7fq2-mx9ta");
    expect(normaliseBackupCode("k7fq2mx9ta")).toBe("k7fq2-mx9ta");
    expect(normaliseBackupCode("123456")).toBeNull();
  });
});
