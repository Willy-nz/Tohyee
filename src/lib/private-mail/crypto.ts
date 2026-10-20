import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { UnavailableError } from "@/lib/errors";
import { decryptSecret, encryptSecret } from "@/lib/secrets";

/*
 * Encryption for a private mail copy (#250; decisions 612, 613). Each copy
 * has its own random 256-bit key, stored only encrypted with the server's
 * TOHYEE_SECRET_KEY (src/lib/secrets). From it come two keys (HKDF): one
 * encrypts every subject, address, body, attachment name and attachment
 * (AES-256-GCM, tied to the copy, the kind of field and the email it belongs
 * to, so a value can't be moved to another row); the other makes the search
 * tokens and thread keys (HMAC-SHA256). Someone with the database alone sees
 * ciphertext and tokens; someone with the database and TOHYEE_SECRET_KEY can
 * read everything (docs/PRIVATE-MAIL.md).
 */

const FORMAT = 1;

export type CopyKeys = { copyId: string; content: Buffer; search: Buffer };

/** A new copy key, as stored (encrypted with the server's key). */
export function newWrappedDataKey(): string {
  return encryptSecret(randomBytes(32).toString("base64"));
}

export function copyKeys(copyId: string, wrapped: string): CopyKeys {
  const raw = Buffer.from(decryptSecret(wrapped), "base64");
  if (raw.length !== 32) throw new UnavailableError("A private mail copy's key can't be read.");
  return {
    copyId,
    content: Buffer.from(hkdfSync("sha256", raw, Buffer.alloc(0), "tohyee private mail content v1", 32)),
    search: Buffer.from(hkdfSync("sha256", raw, Buffer.alloc(0), "tohyee private mail search v1", 32)),
  };
}

function aad(keys: CopyKeys, kind: string, externalId: string): Buffer {
  return Buffer.from(`copy:${keys.copyId}|${kind}|${externalId}`, "utf8");
}

export function seal(keys: CopyKeys, kind: string, externalId: string, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.content, iv);
  cipher.setAAD(aad(keys, kind, externalId));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT]), iv, cipher.getAuthTag(), body]);
}

export function open(keys: CopyKeys, kind: string, externalId: string, sealed: Buffer): Buffer {
  if (sealed.length < 29 || sealed[0] !== FORMAT) throw new UnavailableError("A private mail value is in an unknown format.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", keys.content, sealed.subarray(1, 13));
    decipher.setAAD(aad(keys, kind, externalId));
    decipher.setAuthTag(sealed.subarray(13, 29));
    return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
  } catch {
    throw new UnavailableError("A private mail value can't be read with this copy's key.");
  }
}

export function sealJson(keys: CopyKeys, kind: string, externalId: string, value: unknown): Buffer {
  return seal(keys, kind, externalId, Buffer.from(JSON.stringify(value), "utf8"));
}

export function openJson<T>(keys: CopyKeys, kind: string, externalId: string, sealed: Buffer): T {
  return JSON.parse(open(keys, kind, externalId, sealed).toString("utf8")) as T;
}

function digest(keys: CopyKeys, value: string): string {
  return createHmac("sha256", keys.search).update(value, "utf8").digest("base64url").slice(0, 22);
}

/** A conversation's key: equal for the same provider thread, unreadable without the copy's key. */
export function threadKey(keys: CopyKeys, threadId: string): string {
  return digest(keys, `thread\0${threadId}`);
}

/** At most this many distinct words are indexed per email. */
export const MAX_TOKENS_PER_EMAIL = 4000;

/**
 * The words searched for (PM9): lower case, accents taken off ("Kōwhai" is
 * "kowhai"), letters and digits only, 2 to 40 characters. Whole words only.
 */
export function searchWords(text: string): string[] {
  const words = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && word.length <= 40);
  return [...new Set(words)];
}

/** The tokens stored for an email: its words, and "from:" / "to:" with each address. */
export function emailTokens(keys: CopyKeys, input: { text: string; from: string[]; to: string[] }): string[] {
  const tokens = new Set<string>();
  for (const address of input.from) tokens.add(digest(keys, `from:${address.toLowerCase()}`));
  for (const address of input.to) tokens.add(digest(keys, `to:${address.toLowerCase()}`));
  for (const word of searchWords(input.text)) {
    if (tokens.size >= MAX_TOKENS_PER_EMAIL) break;
    tokens.add(digest(keys, word));
  }
  return [...tokens];
}

/**
 * A search as tokens: every word must be in the email. "from:address" and
 * "to:address" match the sender or a recipient exactly. Nothing else of the
 * search is kept or logged.
 */
export function queryTokens(keys: CopyKeys, query: string): string[] {
  const tokens = new Set<string>();
  for (const term of query.trim().split(/\s+/).filter(Boolean)) {
    const address = /^(from|to):(\S+@\S+)$/i.exec(term);
    if (address) tokens.add(digest(keys, `${address[1].toLowerCase()}:${address[2].toLowerCase()}`));
    else for (const word of searchWords(term)) tokens.add(digest(keys, word));
  }
  return [...tokens].slice(0, 20);
}
