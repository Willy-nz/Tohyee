import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("the cost a stored password hash may ask for (#698)", () => {
  it("checks a hash Tohyee made, and refuses one asking for far more work without running it", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("wrong horse battery", stored)).toBe(false);
    const [, , , , salt, hash] = stored.split("$");
    const started = Date.now();
    for (const [n, r, p] of [
      [2 ** 21, 8, 1],
      [2 ** 15, 64, 1],
      [2 ** 15, 8, 5000],
      [2 ** 15 + 1, 8, 1],
      [0, 8, 1],
    ]) {
      expect(await verifyPassword("correct horse battery", ["scrypt", n, r, p, salt, hash].join("$")), `${n} ${r} ${p}`).toBe(false);
    }
    // Refused, not worked out: nothing like the seconds p = 5000 would take.
    expect(Date.now() - started).toBeLessThan(500);
  });
});
