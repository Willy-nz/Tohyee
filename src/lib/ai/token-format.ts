import { createHash, randomBytes } from "node:crypto";

/**
 * Personal AI access keys (decision 340): `tohyee_ai_` then 32 random bytes
 * as base64url (43 characters). Only the SHA-256 (hex) is stored, with the
 * first 8 characters of the random part so people can tell their keys apart.
 */
export const AI_TOKEN_PREFIX = "tohyee_ai_";
const RANDOM_BYTES = 32;
const TOKEN_PATTERN = /^tohyee_ai_[A-Za-z0-9_-]{43,100}$/;

export function newAiToken(): string {
  return `${AI_TOKEN_PREFIX}${randomBytes(RANDOM_BYTES).toString("base64url")}`;
}

export function hashAiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The 8 characters after `tohyee_ai_`, shown as "tohyee_ai_abcd1234…". */
export function aiTokenDisplayPrefix(token: string): string {
  return token.slice(AI_TOKEN_PREFIX.length, AI_TOKEN_PREFIX.length + 8);
}

export function looksLikeAiToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/**
 * The key from an `Authorization: Bearer tohyee_ai_…` header, or null when
 * there's no such header or it isn't shaped like a key.
 */
export function bearerAiToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  if (!match) return null;
  return looksLikeAiToken(match[1]) ? match[1] : null;
}
