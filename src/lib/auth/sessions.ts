import { createHash, randomBytes } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { DbClient } from "@/lib/db/transactions";
import { coreQuery } from "@/lib/db/transactions";
import { secretsAvailable } from "@/lib/secrets";
import { noteActiveUser } from "@/lib/server-stats/counters";

export const SESSION_COOKIE = "tohyee_session";
/** A session ends after this many days without use (see getSessionUser). */
export const SESSION_LIFETIME_DAYS = 14;
const REFRESH_AFTER_MS = 60 * 60 * 1000;
/** A session waiting for the second step lasts this long. */
export const PENDING_SESSION_MINUTES = 10;
/**
 * The browser keeps the cookie for 400 days (the most browsers allow) and the
 * server decides when the session ends. A cookie that expired 14 days after
 * sign-in would sign active people out even though their session had slid on.
 */
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  isServerAdmin: boolean;
};

export type SessionMeta = {
  userAgent: string | null;
  ipAddress: string | null;
};

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * How a session was signed in (#424): Google sign-ins rely on Google's own
 * checks, not Tohyee's two-step. A passkey sign-in (#450) counts as two-step
 * in itself: the device plus a face, finger or PIN.
 */
export type SignInMethod = "password" | "google" | "passkey";

/**
 * Creates a session. A `pending` session is one where the password was right
 * but the second step (authenticator code) isn't done yet: it lasts 10
 * minutes and can only finish signing in.
 */
export async function createSession(
  client: DbClient,
  userId: string,
  meta: SessionMeta,
  options: { pending?: boolean; method?: SignInMethod; passkeyId?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const lifetimeMs = options.pending ? PENDING_SESSION_MINUTES * 60 * 1000 : SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + lifetimeMs);
  await client.query(
    `insert into sessions (id, user_id, expires_at, user_agent, ip_address, two_step_pending, sign_in_method, passkey_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      hashSessionToken(token),
      userId,
      expiresAt.toISOString(),
      meta.userAgent?.slice(0, 300) ?? null,
      meta.ipAddress?.slice(0, 64) ?? null,
      options.pending === true,
      options.method ?? "password",
      options.passkeyId ?? null,
    ],
  );
  // Opportunistic clean-up of expired sessions.
  await client.query("delete from sessions where expires_at < now() - interval '1 day'");
  return { token, expiresAt };
}

/**
 * Whether everyone must use two-step sign-in. It's on whenever the server can
 * store the authenticator keys safely (TOHYEE_SECRET_KEY is set); without the
 * key, sign-in falls back to the password alone and server admins are warned.
 */
export function twoStepRequired(): boolean {
  return secretsAvailable();
}

type SessionRow = {
  session_id: string;
  last_seen_at: string;
  two_step_pending: boolean;
  user_id: string;
  email: string;
  display_name: string;
  is_server_admin: boolean;
  two_step_enabled: boolean;
  sign_in_method: SignInMethod;
};

/**
 * Where a session is up to:
 * - "full": signed in;
 * - "verify": password done, authenticator code (or a backup code) needed;
 * - "enrol": the user hasn't set up two-step sign-in yet and must before
 *   doing anything else.
 */
export type SessionStage = "full" | "verify" | "enrol";

export type SessionState = {
  sessionId: string;
  user: SessionUser;
  stage: SessionStage;
  pending: boolean;
  method: SignInMethod;
};

/**
 * Looks up a session token, whatever stage it's at. Full sessions slide: each
 * use (at most hourly) pushes the expiry out again, so active people stay
 * signed in. Pending sessions don't slide.
 */
export async function getSessionState(token: string | null): Promise<SessionState | null> {
  if (!token || token.length < 20 || token.length > 200) {
    return null;
  }
  const sessionId = hashSessionToken(token);
  const result = await coreQuery<SessionRow>(
    `select s.id as session_id, s.last_seen_at, s.two_step_pending, u.id as user_id, u.email,
            u.display_name, u.is_server_admin, u.totp_enabled_at is not null as two_step_enabled, s.sign_in_method
       from sessions s
       join users u on u.id = s.user_id
      where s.id = $1 and s.expires_at > now() and u.is_active`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const required = twoStepRequired();
  // A Google sign-in (#424, decision 802) relies on Google's own checks, as
  // Xero's does, so it never asks for Tohyee's authenticator code. A passkey
  // sign-in (#450, decision 887) is two-step in itself.
  const noCodeNeeded = (row.sign_in_method === "google" || row.sign_in_method === "passkey") && !row.two_step_pending;
  const stage: SessionStage = noCodeNeeded
    ? "full"
    : row.two_step_pending && row.two_step_enabled
      ? "verify"
      : required && !row.two_step_enabled
        ? "enrol"
        : "full";
  if (stage === "full") noteActiveUser(row.user_id);
  if (stage === "full" && !row.two_step_pending && Date.now() - new Date(row.last_seen_at).getTime() > REFRESH_AFTER_MS) {
    await coreQuery(
      `update sessions
          set last_seen_at = now(),
              expires_at = now() + ($2::int * interval '1 day')
        where id = $1`,
      [sessionId, SESSION_LIFETIME_DAYS],
    );
  }
  return {
    sessionId,
    stage,
    pending: row.two_step_pending,
    method: row.sign_in_method,
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      isServerAdmin: row.is_server_admin,
    },
  };
}

/**
 * The user behind a fully signed-in session (password and, where required,
 * the second step). Sessions part-way through signing in get null.
 */
export async function getSessionUser(token: string | null): Promise<{
  sessionId: string;
  user: SessionUser;
} | null> {
  const state = await getSessionState(token);
  if (!state || state.stage !== "full" || state.pending) {
    return null;
  }
  return { sessionId: state.sessionId, user: state.user };
}

export async function deleteSession(sessionId: string): Promise<void> {
  await coreQuery("delete from sessions where id = $1", [sessionId]);
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function isSecureRequest(request: Request): boolean {
  const override = process.env.TOHYEE_COOKIE_SECURE?.trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    return forwarded.split(",")[0].trim() === "https";
  }
  return new URL(request.url).protocol === "https:";
}

export function sessionCookieHeader(request: Request, token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (isSecureRequest(request)) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function clearSessionCookieHeader(request: Request): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (isSecureRequest(request)) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function sessionMetaFrom(request: Request): SessionMeta {
  return {
    userAgent: request.headers.get("user-agent"),
    ipAddress: clientAddress(request.headers),
  };
}

/** This computer, in every way it can be written (127.x, ::1, 0:0:0:0:0:0:0:1, ::ffff:127.x). */
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

let trusted: { setting: string; list: BlockList } | null = null;

/**
 * Proxies of your own between the internet and Tohyee (decision 534), from
 * TOHYEE_TRUSTED_PROXIES: addresses or ranges, comma-separated, such as
 * "172.17.0.1" or "10.0.0.0/8". Their entries in X-Forwarded-For are skipped
 * like this computer's, so a proxy in Docker isn't taken for every visitor.
 */
function trustedProxies(): BlockList {
  const setting = process.env.TOHYEE_TRUSTED_PROXIES?.trim() ?? "";
  if (trusted?.setting === setting) return trusted.list;
  const list = new BlockList();
  for (const entry of setting.split(",").map((part) => part.trim()).filter(Boolean)) {
    const [address, bits] = entry.split("/");
    const type = isIP(address);
    if (!type) continue;
    const family = type === 4 ? "ipv4" : "ipv6";
    if (bits === undefined) list.addAddress(address, family);
    else if (/^\d+$/.test(bits) && Number(bits) <= (type === 4 ? 32 : 128)) list.addSubnet(address, Number(bits), family);
  }
  trusted = { setting, list };
  return list;
}

/** An X-Forwarded-For entry as a bare address: no port, no brackets; null when it isn't one. */
function bareAddress(entry: string): string | null {
  let address = entry.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) address = bracketed[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(address)) address = address.slice(0, address.lastIndexOf(":"));
  return isIP(address) ? address : null;
}

function isProxyHop(address: string): boolean {
  const family = isIP(address) === 4 ? "ipv4" : "ipv6";
  return loopback.check(address, family) || trustedProxies().check(address, family);
}

/** The addresses in X-Forwarded-For, in order, leaving out entries that aren't addresses. */
export function forwardedAddresses(headers: Headers): string[] {
  return (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map(bareAddress)
    .filter((entry): entry is string => entry !== null);
}

/**
 * The address a request came from (#208 item 3, decision 534). Proxies add the
 * address they saw to the END of X-Forwarded-For (Cloudflare appends the
 * visitor's address to whatever the visitor sent; Next.js fills it in from the
 * connection when it's missing), so the last entry that isn't this computer
 * or a trusted proxy is the one a proxy wrote. The first entry is whatever the
 * visitor typed, and taking it let the per-address sign-in limit be dodged by
 * changing it on every try. Entries that aren't addresses are ignored.
 *
 * This relies on a proxy or tunnel in front: Tohyee can't see the connection's
 * own address, so with the port opened straight to the internet a visitor's
 * own X-Forwarded-For is all there is. That set-up isn't supported.
 */
export function clientAddress(headers: Headers): string | null {
  const forwarded = forwardedAddresses(headers);
  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    if (!isProxyHop(forwarded[index])) return forwarded[index];
  }
  if (forwarded.length > 0) return forwarded.at(-1)!;
  return bareAddress(headers.get("x-real-ip") ?? "");
}
