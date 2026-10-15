import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, keyedSecretHash } from "@/lib/secrets";

const KEY = "unit-test-secret-key-that-is-at-least-32-characters";

/** A secret as Tohyee stored them before v2: AES-256-GCM with the SHA-256 of the key. */
function storedV1(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(KEY, "utf8").digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

describe("stored secrets", () => {
  const previous = process.env.TOHYEE_SECRET_KEY;
  beforeEach(() => {
    process.env.TOHYEE_SECRET_KEY = KEY;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previous;
  });

  it("encrypts new secrets as v2, which open again", () => {
    const stored = encryptSecret("bank-feed-token");
    expect(stored.startsWith("v2:")).toBe(true);
    expect(decryptSecret(stored)).toBe("bank-feed-token");
  });

  it("still opens secrets stored as v1", () => {
    expect(decryptSecret(storedV1("two-step-key"))).toBe("two-step-key");
  });

  it("uses a different key for v2 than for v1 and keyed digests", () => {
    const relabelled = encryptSecret("x").replace(/^v2:/, "v1:");
    expect(() => decryptSecret(relabelled)).toThrow(/can't be read/);
  });

  it("keeps keyed digests the same, so ones already stored still match", () => {
    const expected = createHmac("sha256", createHash("sha256").update(KEY, "utf8").digest()).update("tohyee-secret-hash\0", "utf8").update("123-456-789", "utf8").digest("hex");
    expect(keyedSecretHash("123-456-789")).toBe(expected);
  });
});
