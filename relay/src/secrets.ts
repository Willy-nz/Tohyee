/** Random names, keys and hashes. Uses only the Web Crypto API. */

/**
 * Letters and digits for address names. No vowels (or y), so names can't
 * spell ordinary words, rude or otherwise, and none of 0/o, 1/l/i to confuse
 * people reading an address aloud.
 */
export const LABEL_ALPHABET = "bcdfghjkmnpqrstvwxz23456789";
export const LABEL_LENGTH = 7;
const LETTERS = "bcdfghjkmnpqrstvwxz";

function uniformChar(alphabet: string): string {
  // Rejection sampling so every character is equally likely.
  const limit = 256 - (256 % alphabet.length);
  const byte = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(byte);
    if (byte[0] < limit) return alphabet[byte[0] % alphabet.length];
  }
}

/** A random, meaningless 7-character name such as "k7m2q9x". Always starts with a letter. */
export function randomLabel(): string {
  let label = uniformChar(LETTERS);
  while (label.length < LABEL_LENGTH) label += uniformChar(LABEL_ALPHABET);
  return label;
}

export function isLabel(value: string): boolean {
  return new RegExp(`^[${LETTERS}][${LABEL_ALPHABET}]{${LABEL_LENGTH - 1}}$`).test(value);
}

/** 32 random bytes, base64url: the release key handed to the Tohyee server once. */
export function randomKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares two secrets without leaking how much of them matched. */
export async function sameSecret(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Compares a secret with a stored SHA-256 hash. */
export async function matchesHash(given: string, storedHash: string): Promise<boolean> {
  const a = await sha256Hex(given);
  if (a.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ storedHash.charCodeAt(i);
  return diff === 0;
}
