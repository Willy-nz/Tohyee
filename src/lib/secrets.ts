import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { UnavailableError } from "@/lib/errors";

/**
 * Encryption for secrets Tohyee has to keep (two-step sign-in keys, the email
 * password, the Cloudflare Tunnel token, bank feed tokens): AES-256-GCM with
 * a key derived from the server's TOHYEE_SECRET_KEY. The key lives in the
 * server's environment (tohyee.env on Windows), never in a database, so a
 * copy of a database alone doesn't reveal the secrets. Changing the key makes
 * stored secrets unreadable; they then have to be entered again.
 */
const VERSION = "v1";

function key(): Buffer {
  const raw = process.env.TOHYEE_SECRET_KEY?.trim();
  if (!raw || raw.length < 32) {
    throw new UnavailableError(
      "The server has no TOHYEE_SECRET_KEY (at least 32 characters), so it can't store secrets such as two-step sign-in keys. A server admin needs to set it in the server's environment and restart Tohyee.",
    );
  }
  return createHash("sha256").update(raw, "utf8").digest();
}

/** Whether TOHYEE_SECRET_KEY is set, so secrets can be stored. */
export function secretsAvailable(): boolean {
  const raw = process.env.TOHYEE_SECRET_KEY?.trim();
  return Boolean(raw && raw.length >= 32);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new UnavailableError("A stored secret is in an unknown format.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new UnavailableError(
      "A stored secret can't be read with this server's TOHYEE_SECRET_KEY (was the key changed?). It has to be set up again.",
    );
  }
}

/** A deterministic, keyed digest for command hashes that contain secret fields. */
export function keyedSecretHash(value: string): string {
  return createHmac("sha256", key()).update("tohyee-secret-hash\0", "utf8").update(value, "utf8").digest("hex");
}
