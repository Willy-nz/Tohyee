import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * The small, pure parts of signing AI apps in with OAuth 2.1 (#427,
 * decisions 810-829): token shapes, PKCE, redirect address rules, the MCP
 * address tokens are bound to, and app names. No database here, so it's
 * unit tested on its own.
 */

/** Access tokens: an hour (decision 815). */
export const ACCESS_TOKEN_SECONDS = 60 * 60;
/** Refresh tokens: 60 days from when each is issued, replaced every time it's used (decision 815, as Xero does). */
export const REFRESH_TOKEN_SECONDS = 60 * 24 * 60 * 60;
/** The one-time code after the person allows the app (decision 814). */
export const AUTHORIZATION_CODE_SECONDS = 5 * 60;
/** How long the person has to sign in and allow it (decision 813). */
export const AUTHORIZATION_REQUEST_SECONDS = 10 * 60;
/** At most this many working connections per person per organisation, as for keys (decision 341). */
export const MAX_ACTIVE_CONNECTIONS = 10;
/** At most this many working PowerPoint add-in sign-ins per person (#429, decision 836): one per computer or browser they use. */
export const MAX_OFFICE_CONNECTIONS = 20;

export const ACCESS_TOKEN_PREFIX = "tohyee_at_";
export const REFRESH_TOKEN_PREFIX = "tohyee_rt_";
export const CODE_PREFIX = "tohyee_code_";

const ACCESS_TOKEN_PATTERN = /^tohyee_at_[A-Za-z0-9_-]{43}$/;

/** 32 random bytes as base64url, after a prefix. */
export function randomToken(prefix = ""): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function looksLikeAccessToken(value: string): boolean {
  return ACCESS_TOKEN_PATTERN.test(value);
}

/** The token in `Authorization: Bearer …`, or null. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636), S256 only (decision 814)

const PKCE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export function validCodeChallenge(value: unknown): value is string {
  return typeof value === "string" && PKCE_PATTERN.test(value);
}

/** Whether `verifier` is the one `challenge` was made from: BASE64URL(SHA256(verifier)), compared in constant time. */
export function pkceMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !PKCE_PATTERN.test(verifier)) return false;
  const made = Buffer.from(createHash("sha256").update(verifier, "ascii").digest("base64url"));
  const wanted = Buffer.from(challenge);
  return made.length === wanted.length && timingSafeEqual(made, wanted);
}

// ---------------------------------------------------------------------------
// Redirect addresses (decision 816)

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Why an app's redirect address can't be used, or null when it can: https,
 * or http only to this computer (localhost, 127.0.0.1, [::1]) as the MCP
 * specification says; no fragment, no user name or password in it, at most
 * 500 characters. Other schemes (app links such as cursor://) aren't
 * accepted.
 */
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== "string" || uri.length === 0) return "A redirect address is missing.";
  if (uri.length > 500) return "A redirect address is longer than 500 characters.";
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "A redirect address isn't a full web address.";
  }
  if (url.hash || uri.includes("#")) return "A redirect address can't have a # part.";
  if (url.username || url.password) return "A redirect address can't have a user name or password in it.";
  if (url.protocol === "https:") return url.hostname ? null : "A redirect address needs a host.";
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return null;
  return "A redirect address must be https, or http on this computer (localhost).";
}

/**
 * Whether the redirect address in a sign-in request is one the app
 * registered: exactly the same text, except that an http address on this
 * computer may use any port (RFC 8252 section 7.3; Claude Code picks a new
 * port each time), with the same host name, path and query.
 */
export function redirectUriMatches(requested: string, registered: readonly string[]): boolean {
  if (registered.includes(requested)) return true;
  if (!isLoopbackRedirect(requested)) return false;
  const asked = new URL(requested);
  return registered.some((entry) => {
    if (!isLoopbackRedirect(entry)) return false;
    const known = new URL(entry);
    return known.hostname === asked.hostname && known.pathname === asked.pathname && known.search === asked.search;
  });
}

/** The host a redirect address sends the person back to, as the consent screen shows it (e.g. "claude.ai"). */
export function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

// ---------------------------------------------------------------------------
// The MCP address tokens are for (RFC 8707, decision 817)

/** The MCP address for a remote access address, e.g. https://glimmers.tohyee.nz/api/mcp. */
export function mcpResourceFor(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/mcp`;
}

/**
 * An address in a comparable form: scheme and host in lower case, no
 * default port, no trailing slash on the path; null when it isn't an
 * absolute http(s) address or has a # part.
 */
export function canonicalResource(value: string): string | null {
  if (value.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/**
 * Whether a `resource` an app sent names Tohyee's MCP address. Tohyee's own
 * address on its own is accepted too, as some apps send that; the token is
 * still bound to the MCP address.
 */
export function resourceIsOurs(requested: string, mcpResource: string): boolean {
  const asked = canonicalResource(requested);
  if (!asked) return false;
  const ours = canonicalResource(mcpResource);
  return asked === ours || asked === canonicalResource(new URL(mcpResource).origin);
}

// ---------------------------------------------------------------------------
// App names (decision 818)

/**
 * An app's name as it's shown and kept: control and formatting characters
 * (including right-to-left overrides) removed, spaces collapsed, at most 60
 * characters. Empty becomes null.
 */
export function cleanClientName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\t\n\r\f\v\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > 60 ? `${cleaned.slice(0, 59).trimEnd()}…` : cleaned;
}

// ---------------------------------------------------------------------------
// Client ID metadata documents (decision 812)

/**
 * Whether a client_id is an address to read the app's details from, as the
 * OAuth Client ID Metadata Document draft says: https, with a path, no #
 * part, no user name or password, no "." or ".." path segments, at most 500
 * characters.
 */
export function isMetadataDocumentClientId(clientId: string): boolean {
  if (clientId.length > 500 || !clientId.startsWith("https://")) return false;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  if (url.hash || clientId.includes("#") || url.username || url.password) return false;
  if (url.pathname === "/" || url.pathname === "") return false;
  const segments = clientId.slice(clientId.indexOf("/", "https://".length)).split("?")[0].split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || /^%2e(%2e)?$/i.test(segment) || /^\.%2e$|^%2e\.$/i.test(segment))) return false;
  return true;
}

/** Seconds from a Cache-Control header's max-age, kept between 5 minutes and a day; an hour when there isn't one. */
export function metadataCacheSeconds(cacheControl: string | null): number {
  const match = cacheControl ? /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl) : null;
  const wanted = match ? Number(match[1]) : 3600;
  if (cacheControl && /no-store|no-cache/i.test(cacheControl)) return 300;
  return Math.min(Math.max(wanted, 300), 86_400);
}

// ---------------------------------------------------------------------------
// Answers to the app

/** The address to send the browser back to the app with: the code (or error), state and iss (RFC 9207). */
export function redirectWith(redirectUri: string, values: Record<string, string | null | undefined>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) url.searchParams.set(name, value);
  }
  return url.toString();
}

/** `WWW-Authenticate` for the MCP endpoint (RFC 9728 section 5.1, RFC 6750 section 3). */
export function wwwAuthenticate(resourceMetadataUrl: string | null, tokenSent: boolean): string {
  const parts = resourceMetadataUrl ? [`resource_metadata="${resourceMetadataUrl}"`] : ['realm="tohyee"'];
  if (tokenSent) parts.push('error="invalid_token"');
  return `Bearer ${parts.join(", ")}`;
}

/** The protected resource metadata address for an MCP address (RFC 9728 section 3.1: the well-known part goes before the path). */
export function resourceMetadataUrlFor(mcpResource: string): string {
  const url = new URL(mcpResource);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname.replace(/\/+$/, "")}`;
}
