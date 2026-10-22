import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";

/**
 * The pure parts of Sign in with Google (#424, decisions 800-809): OpenID
 * Connect's authorisation address with state, nonce and PKCE, and the checks
 * on the ID token Google returns. No network and no database here.
 */

export const GOOGLE_SIGN_IN_CALLBACK_PATH = "/api/auth/google/callback";
/** Sign-in scopes only: nothing about the person's mailbox, calendar or files. */
export const GOOGLE_SIGN_IN_SCOPES = ["openid", "email", "profile"] as const;
export const GOOGLE_AUTHORISE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** Google's issuer, in both forms its discovery document and tokens use. */
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
/** Clock difference allowed between this server and Google. */
const SKEW_MS = 2 * 60_000;
/** An ID token issued longer ago than this isn't from the sign-in just made. */
const MAX_AGE_MS = 15 * 60_000;

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** PKCE (RFC 7636) S256: the challenge sent to Google for a verifier kept on the server. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function googleSignInUrl(input: { clientId: string; redirectUri: string; state: string; nonce: string; codeChallenge: string; loginHint?: string | null }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_SIGN_IN_SCOPES.join(" "),
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  if (input.loginHint) params.set("login_hint", input.loginHint);
  return `${GOOGLE_AUTHORISE_URL}?${params}`;
}

export function googleRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${GOOGLE_SIGN_IN_CALLBACK_PATH}`;
}

const LOCAL_SUFFIXES = [".local", ".lan", ".home", ".internal", ".localdomain", ".home.arpa"];

/**
 * Why Google won't accept this address as a sign-in return address, or null
 * when it will. Google only takes https addresses on a public domain name, or
 * localhost on this computer; not a network address like 192.168.1.20 and
 * not a home-network name.
 */
export function redirectOriginProblem(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return "That isn't a web address.";
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return null;
  if (isIP(host)) {
    return `Google doesn't accept a network address (${host}) as a sign-in address. Use Tohyee through its web address (remote access), or on the server computer itself.`;
  }
  if (!host.includes(".") || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return `Google only accepts a public web address, not a home-network name like ${host}. Set up remote access so Tohyee has a web address.`;
  }
  if (url.protocol !== "https:") return `Google needs the sign-in address to start with https://, not ${url.protocol}//.`;
  return null;
}

export type GoogleIdentity = { sub: string; email: string; name: string | null };

export class IdTokenError extends Error {}

function decodePart(part: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // falls through
  }
  throw new IdTokenError("Google's sign-in answer couldn't be read.");
}

/**
 * Checks the ID token from Google's token endpoint (OpenID Connect Core
 * 3.1.3.7): issuer, audience (and azp), expiry and issue time, the nonce
 * this sign-in sent, a verified email, and Google's account ID (`sub`).
 *
 * The signature isn't checked here: the token comes straight from
 * oauth2.googleapis.com over TLS in exchange for a one-time code, the client
 * secret and the PKCE verifier, which OpenID Connect Core 3.1.3.7 step 6
 * allows in place of checking the signature (decision 803). The browser
 * never hands Tohyee an ID token.
 */
export function verifyGoogleIdToken(idToken: unknown, expected: { clientId: string; nonce: string; now?: number }): GoogleIdentity {
  if (typeof idToken !== "string" || idToken.length > 8192) throw new IdTokenError("Google didn't send an ID token.");
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new IdTokenError("Google's ID token isn't in the expected form.");
  decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  const now = expected.now ?? Date.now();

  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.includes(claims.iss)) throw new IdTokenError("The ID token wasn't issued by Google.");
  const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud.filter((value): value is string => typeof value === "string") : [];
  if (!audiences.includes(expected.clientId)) throw new IdTokenError("The ID token is for a different Google app.");
  if (claims.azp !== undefined && claims.azp !== expected.clientId) throw new IdTokenError("The ID token is for a different Google app.");
  if (audiences.length > 1 && claims.azp !== expected.clientId) throw new IdTokenError("The ID token is for a different Google app.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 + SKEW_MS <= now) throw new IdTokenError("Google's sign-in has expired. Try again.");
  if (typeof claims.iat !== "number" || claims.iat * 1000 > now + SKEW_MS || claims.iat * 1000 < now - MAX_AGE_MS) {
    throw new IdTokenError("Google's sign-in isn't from just now. Try again.");
  }
  if (typeof claims.nonce !== "string" || claims.nonce !== expected.nonce) throw new IdTokenError("Google's sign-in doesn't match the one Tohyee started. Try again.");
  if (typeof claims.sub !== "string" || !/^[A-Za-z0-9._-]{1,255}$/.test(claims.sub)) throw new IdTokenError("Google didn't say which account this is.");
  if (typeof claims.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) || claims.email.length > 254) {
    throw new IdTokenError("Google didn't share the account's email address.");
  }
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    throw new IdTokenError("Google says this account's email address isn't verified, so it can't be used to sign in.");
  }
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 100) : null;
  return { sub: claims.sub, email: claims.email.toLowerCase(), name };
}
