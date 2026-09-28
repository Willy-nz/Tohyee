import { createHash, randomBytes } from "node:crypto";
import type { DbClient } from "@/lib/db/transactions";
import { coreQuery } from "@/lib/db/transactions";
import { secretsAvailable } from "@/lib/secrets";

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
 * Creates a session. A `pending` session is one where the password was right
 * but the second step (authenticator code) isn't done yet: it lasts 10
 * minutes and can only finish signing in.
 */
export async function createSession(
  client: DbClient,
  userId: string,
  meta: SessionMeta,
  options: { pending?: boolean } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const lifetimeMs = options.pending ? PENDING_SESSION_MINUTES * 60 * 1000 : SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + lifetimeMs);
  await client.query(
    `insert into sessions (id, user_id, expires_at, user_agent, ip_address, two_step_pending)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      hashSessionToken(token),
      userId,
      expiresAt.toISOString(),
      meta.userAgent?.slice(0, 300) ?? null,
      meta.ipAddress?.slice(0, 64) ?? null,
      options.pending === true,
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
            u.display_name, u.is_server_admin, u.totp_enabled_at is not null as two_step_enabled
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
  const stage: SessionStage =
    row.two_step_pending && row.two_step_enabled ? "verify" : required && !row.two_step_enabled ? "enrol" : "full";
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

function isSecureRequest(request: Request): boolean {
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
  const forwardedFor = request.headers.get("x-forwarded-for");
  return {
    userAgent: request.headers.get("user-agent"),
    ipAddress: forwardedFor ? forwardedFor.split(",")[0].trim() : request.headers.get("x-real-ip"),
  };
}
