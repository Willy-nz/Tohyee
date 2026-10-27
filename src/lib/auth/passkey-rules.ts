import { isIP } from "node:net";
import { localHostName } from "@/lib/net/local-names";

/**
 * The pure rules behind passkeys (#450, decisions 885-899), kept apart so
 * they can be tested without a database.
 */

export type PasskeyAddress = { origin: string; rpId: string; problem: null } | { origin: string; rpId: null; problem: string };

/**
 * Whether passkeys can work on the address a browser is using (decision
 * 889). A passkey belongs to one web address (its "relying party ID"), and
 * browsers and phones only make or use one on a secure address that's a real
 * name: https on a proper web address, or localhost on the server computer
 * itself. A home-network number (192.168.1.20) or name (farm-pc, tohyee.local)
 * is refused by phones, so Tohyee says so rather than letting the phone fail.
 */
export function passkeyAddress(origin: string): PasskeyAddress {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { origin, rpId: null, problem: "Passkeys can't be used on this address." };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  if (host === "localhost") return { origin: url.origin, rpId: "localhost", problem: null };
  if (isIP(bare)) {
    return {
      origin: url.origin,
      rpId: null,
      problem: `Passkeys don't work on an address made of numbers (${bare}): phones and browsers refuse them there. Use Tohyee's web address (Remote access), or localhost on the server computer itself.`,
    };
  }
  if (localHostName(host)) {
    return {
      origin: url.origin,
      rpId: null,
      problem: `Passkeys don't work on a home-network name (${host}): phones and browsers refuse them there. Use Tohyee's web address (Remote access), or localhost on the server computer itself.`,
    };
  }
  if (url.protocol !== "https:") {
    return { origin: url.origin, rpId: null, problem: "Passkeys need a secure (https) address. Use Tohyee's web address (Remote access), or localhost on the server computer itself." };
  }
  return { origin: url.origin, rpId: host, problem: null };
}

/** Where a passkey works, in words: "on the server computer (localhost)" or "at books.example.nz". */
export function passkeyPlace(rpId: string): string {
  return rpId === "localhost" ? "on the server computer (localhost)" : `at ${rpId}`;
}

export const PASSKEY_NAME_MAX = 60;

/** A passkey's name as typed: trimmed, one line, 1-60 characters; null when it's not usable. */
export function cleanPasskeyName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const name = input.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > PASSKEY_NAME_MAX) return null;
  return name;
}

/** A starting name for a new passkey, from the browser it's made in ("iPhone", "Windows computer"). */
export function suggestPasskeyName(userAgent: string | null | undefined): string {
  const agent = userAgent ?? "";
  if (/iPhone/i.test(agent)) return "iPhone";
  if (/iPad/i.test(agent)) return "iPad";
  if (/Android/i.test(agent)) return "Android phone";
  if (/Windows/i.test(agent)) return "Windows computer";
  if (/Macintosh|Mac OS X/i.test(agent)) return "Mac";
  if (/CrOS/i.test(agent)) return "Chromebook";
  if (/Linux/i.test(agent)) return "Linux computer";
  return "Passkey";
}

export type CounterCheck = "ok" | "warn" | "refuse";

/**
 * A passkey's use count (decision 893). Most phone passkeys always say 0,
 * which is fine. A count that goes up is fine. A security key that says a
 * smaller number than last time (and not 0) may have been copied: refused.
 * The same number again, or 0 after counting, is odd but happens with some
 * authenticators: allowed, and flagged in the sign-in monitor.
 */
export function checkCounter(stored: number, received: number): CounterCheck {
  if (stored === 0 && received === 0) return "ok";
  if (received > stored) return "ok";
  if (received !== 0 && received < stored) return "refuse";
  return "warn";
}

/** The challenge a browser's response answers, read from its client data (null when it isn't there). */
export function challengeIn(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== "string" || clientDataJSON.length > 4000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(clientDataJSON)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as { challenge?: unknown };
    return typeof parsed.challenge === "string" && /^[A-Za-z0-9_-]{16,200}$/.test(parsed.challenge) ? parsed.challenge : null;
  } catch {
    return null;
  }
}
