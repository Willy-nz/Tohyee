import { revokeUserAiKeys } from "@/lib/ai/tokens";
import { type AdminActor, writeAdminAuditEvent } from "@/lib/audit";
import {
  type GoogleIdentity,
  googleRedirectUri,
  googleSignInUrl,
  IdTokenError,
  pkceChallenge,
  randomToken,
  redirectOriginProblem,
  sha256Hex,
  verifyGoogleIdToken,
} from "@/lib/auth/google-oidc";
import { type GoogleSignInCode, safeNextPath } from "@/lib/auth/google-messages";
import { authenticate } from "@/lib/auth/guard";
import { configuredOrigin, returnOrigin } from "@/lib/auth/origin";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { assertSignInRate } from "@/lib/auth/rate-limit";
import { assertRemoteAllowed } from "@/lib/auth/remote";
import { claimPasswordTry, lockIfTooManyFailures } from "@/lib/auth/service";
import {
  createSession,
  getSessionUser,
  isSecureRequest,
  readCookie,
  SESSION_COOKIE,
  sessionCookieHeader,
  sessionMetaFrom,
  twoStepRequired,
} from "@/lib/auth/sessions";
import { logSignIn } from "@/lib/auth/sign-in-log";
import { exchangeCode, type ProviderApp } from "@/lib/crm/mail/providers";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { sendSecurityAlert } from "@/lib/email/mailer";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, UnavailableError, ValidationError } from "@/lib/errors";
import { secretsAvailable } from "@/lib/secrets";
import { readServerSetting, writeServerSetting } from "@/lib/server-settings";

/**
 * Sign in with Google for invited people (#424, decisions 800-809; Jess,
 * 22 Oct 2026: "Yes just google for now"). OpenID Connect's authorisation
 * code flow with state, nonce and PKCE, through a Google app a server admin
 * sets up in Server settings (often the same app an organisation uses for
 * Gmail and Google Analytics).
 *
 * - Invited people only: a Google account is only ever linked from a setup
 *   link (to the invited address) or from Your account by someone already
 *   signed in with their password and two-step. An unlinked Google account
 *   can't create a login, and a login is never found by email address.
 * - Each trip to Google is tied to the browser that started it (a cookie
 *   whose hash is kept with the state) and used once within 10 minutes.
 * - A Google sign-in relies on Google's own checks, as Xero's does; password
 *   sign-ins still use Tohyee's two-step. Server admins always keep a
 *   password.
 */

const SETTING_KEY = "google_sign_in";
export const GOOGLE_BROWSER_COOKIE = "tohyee_google_signin";
const COOKIE_PATH = "/api/auth/google";
const STATE_MINUTES = 10;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9-]{1,100}\.apps\.googleusercontent\.com$/;

type SettingValue = { enabled?: boolean; clientId?: string; copiedFromOrganisationId?: string | null };
type SettingSecrets = { clientSecret?: string };

export type GoogleSignInAddress = { label: string; uri: string; problem: string | null };

export type GoogleSignInSettings = {
  enabled: boolean;
  clientId: string | null;
  hasSecret: boolean;
  /** Secrets are saved but can't be read (no TOHYEE_SECRET_KEY, or a different one). */
  secretUnreadable: boolean;
  secretsAvailable: boolean;
  copiedFromOrganisationId: string | null;
  updatedAt: string | null;
  updatedByEmail: string | null;
  /** The sign-in addresses to add to the Google app, and whether Google will take each. */
  addresses: GoogleSignInAddress[];
  /** Ready: on, with a client ID and a readable secret. */
  ready: boolean;
};

async function readSettings() {
  return readServerSetting<SettingValue, SettingSecrets>(SETTING_KEY);
}

/** The Google app for signing in, or null when Sign in with Google is off or not fully set up. */
export async function googleSignInApp(): Promise<ProviderApp | null> {
  if (!secretsAvailable()) return null;
  const stored = await readSettings();
  if (!stored.value.enabled || !stored.value.clientId || !stored.secretsReadable || !stored.secrets.clientSecret) return null;
  return { clientId: stored.value.clientId, clientSecret: stored.secrets.clientSecret };
}

export async function googleSignInAvailable(): Promise<boolean> {
  return (await googleSignInApp()) !== null;
}

/** The server settings page: what's saved (never the secret) and the addresses to give Google. */
export async function getGoogleSignInSettings(request: Request): Promise<GoogleSignInSettings> {
  const stored = await readSettings();
  const addresses: GoogleSignInAddress[] = [];
  const publicAddress = await configuredOrigin();
  if (publicAddress) addresses.push({ label: "Tohyee's web address (remote access)", uri: googleRedirectUri(publicAddress), problem: redirectOriginProblem(publicAddress) });
  const here = await returnOrigin(request);
  if (!addresses.some((entry) => entry.uri === googleRedirectUri(here))) {
    addresses.push({ label: "The address you're using now (only needed to sign in with Google this way)", uri: googleRedirectUri(here), problem: redirectOriginProblem(here) });
  }
  const hasSecret = Boolean(stored.secrets.clientSecret) || !stored.secretsReadable;
  const ready = Boolean(stored.value.enabled && stored.value.clientId && stored.secretsReadable && stored.secrets.clientSecret && secretsAvailable());
  return {
    enabled: stored.value.enabled === true,
    clientId: stored.value.clientId ?? null,
    hasSecret,
    secretUnreadable: !stored.secretsReadable,
    secretsAvailable: secretsAvailable(),
    copiedFromOrganisationId: stored.value.copiedFromOrganisationId ?? null,
    updatedAt: stored.updatedAt ? new Date(stored.updatedAt).toISOString() : null,
    updatedByEmail: stored.updatedByEmail,
    addresses,
    ready,
  };
}

/**
 * Saves the server's Google sign-in app (server admins, on the server
 * computer). `clientSecret` blank keeps the saved one; `app` (from an
 * organisation's Settings › Email) copies that organisation's app instead.
 */
export async function saveGoogleSignInSettings(
  actor: AdminActor,
  input: { enabled?: unknown; clientId?: unknown; clientSecret?: unknown },
  copied?: { app: ProviderApp; organisationId: string },
): Promise<void> {
  if (!secretsAvailable()) {
    throw new UnavailableError("This server has no TOHYEE_SECRET_KEY, so it can't keep the Google app's secret safely. Set it first.");
  }
  const stored = await readSettings();
  const clientIdInput = copied ? copied.app.clientId : typeof input.clientId === "string" ? input.clientId.trim() : (stored.value.clientId ?? "");
  const secretInput = copied ? copied.app.clientSecret : typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
  const enabled = input.enabled === undefined ? stored.value.enabled === true : input.enabled === true;
  if (clientIdInput && !CLIENT_ID_PATTERN.test(clientIdInput)) {
    throw new ValidationError("A Google client ID ends in .apps.googleusercontent.com. Copy it from the Google app's OAuth client.");
  }
  if (secretInput.length > 200) throw new ValidationError("That client secret is too long.");
  const secret = secretInput || (stored.secretsReadable ? stored.secrets.clientSecret : undefined);
  if (enabled && (!clientIdInput || !secret)) throw new ValidationError("Enter the Google app's client ID and secret before turning Sign in with Google on.");
  const clientChanged = clientIdInput !== (stored.value.clientId ?? "");
  await withCoreTransaction(async (client) => {
    await writeServerSetting<SettingValue, SettingSecrets>(
      client,
      SETTING_KEY,
      {
        enabled,
        clientId: clientIdInput || undefined,
        copiedFromOrganisationId: copied ? copied.organisationId : clientChanged || secretInput ? null : (stored.value.copiedFromOrganisationId ?? null),
      },
      secret ? { clientSecret: secret } : {},
      actor.email,
    );
    await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
      eventType: "server.google_sign_in_updated",
      entityType: "server_setting",
      entityId: SETTING_KEY,
      details: { enabled, clientId: clientIdInput || null, secretChanged: Boolean(secretInput), copiedFrom: copied?.organisationId ?? null },
    });
  });
}

// ---------------------------------------------------------------------------
// Starting: off to Google

export type GoogleStartPurpose = "sign_in" | "setup" | "link";

function browserCookie(request: Request, value: string, maxAge: number): string {
  const parts = [`${GOOGLE_BROWSER_COOKIE}=${value}`, `Path=${COOKIE_PATH}`, "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

export function clearBrowserCookie(request: Request): string {
  return browserCookie(request, "", 0);
}

/**
 * Google's sign-in address for this browser, and the cookie that ties the
 * trip to it. `setup` needs the setup link's `token`; `link` needs a full
 * session and the person's current `password`.
 */
export async function startGoogleSignIn(
  request: Request,
  input: { purpose?: unknown; next?: unknown; token?: unknown; password?: unknown },
): Promise<{ url: string; cookie: string }> {
  const purpose = input.purpose;
  if (purpose !== "sign_in" && purpose !== "setup" && purpose !== "link") throw new ValidationError("Choose how to use Google.");
  const app = await googleSignInApp();
  if (!app) throw new ConflictError("Sign in with Google isn't turned on on this server.");
  const origin = await returnOrigin(request);
  const problem = redirectOriginProblem(origin);
  if (problem) throw new ValidationError(problem);

  let userId: string | null = null;
  let sessionId: string | null = null;
  let setupTokenHash: string | null = null;
  let loginHint: string | null = null;
  let nextPath: string | null = null;

  if (purpose === "sign_in") {
    nextPath = safeNextPath(input.next);
  } else if (purpose === "setup") {
    const token = typeof input.token === "string" ? input.token : "";
    if (!token) throw new UnauthorizedError("This setup link is missing its code. Open the link again.");
    setupTokenHash = sha256Hex(token);
    const link = await coreQuery<{ email: string; is_server_admin: boolean }>(
      `select u.email, u.is_server_admin from user_setup_links l join users u on u.id = l.user_id
        where l.token_hash = $1 and l.used_at is null and l.expires_at > now() and u.is_active`,
      [setupTokenHash],
    );
    const row = link.rows[0];
    if (!row) throw new UnauthorizedError("This setup link has expired or was already used. Ask your server admin for a new one.");
    if (row.is_server_admin) throw new ForbiddenError("Server admins always keep a password, so this login can't be set up with Google. Choose a password instead.");
    loginHint = row.email;
  } else {
    const auth = await authenticate(request);
    const found = await coreQuery<{ password_hash: string; google_only: boolean; linked: boolean }>(
      `select u.password_hash, u.google_only, exists (select 1 from user_google_identities g where g.user_id = u.id) as linked
         from users u where u.id = $1 and u.is_active`,
      [auth.user.id],
    );
    const row = found.rows[0];
    if (!row) throw new UnauthorizedError();
    if (row.linked) throw new ConflictError("A Google account is already linked to your login. Unlink it first to link a different one.");
    // Your password again, so a session left open (or taken) can't quietly add a way in.
    const password = typeof input.password === "string" ? input.password : "";
    if (!password) throw new ValidationError("Enter your password to link a Google account.");
    await claimPasswordTry(auth.user.id);
    if (!(await verifyPassword(password, row.password_hash))) {
      await lockIfTooManyFailures(auth.user.id);
      throw new ValidationError("Your password isn't right.");
    }
    await coreQuery("update users set failed_login_count = 0 where id = $1", [auth.user.id]);
    userId = auth.user.id;
    sessionId = auth.sessionId;
    loginHint = auth.user.email;
  }

  const state = randomToken();
  const browser = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const redirectUri = googleRedirectUri(origin);
  await coreQuery(
    `insert into google_sign_in_states (state_hash, browser_hash, purpose, code_verifier, nonce, redirect_uri, next_path, user_id, session_id, setup_token_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [sha256Hex(state), sha256Hex(browser), purpose, verifier, nonce, redirectUri, nextPath, userId, sessionId, setupTokenHash],
  );
  await coreQuery("delete from google_sign_in_states where created_at < now() - interval '1 day'");
  return {
    url: googleSignInUrl({ clientId: app.clientId, redirectUri, state, nonce, codeChallenge: pkceChallenge(verifier), loginHint }),
    cookie: browserCookie(request, browser, STATE_MINUTES * 60),
  };
}

// ---------------------------------------------------------------------------
// Coming back from Google

type StateRow = {
  purpose: GoogleStartPurpose;
  code_verifier: string;
  nonce: string;
  redirect_uri: string;
  next_path: string | null;
  user_id: string | null;
  session_id: string | null;
  setup_token_hash: string | null;
};

export type GoogleCallbackResult = { location: string; cookies: string[] };

const FAILURE_PAGE: Record<GoogleStartPurpose, string> = {
  sign_in: "/login",
  setup: "/login/setup-account",
  link: "/operations/profile",
};

class Refusal extends Error {
  constructor(readonly code: GoogleSignInCode) {
    super(code);
  }
}

/** Lets tests move Google's clock with Tohyee's. */
let clock: () => number = () => Date.now();
export function setGoogleClockForTests(replacement: (() => number) | null): void {
  clock = replacement ?? (() => Date.now());
}

/**
 * The callback: checks the browser cookie and the one-time state, swaps the
 * code (with the PKCE verifier) for Google's ID token outside any database
 * transaction, checks the token, then signs in, finishes the setup link or
 * links the account. Always sends the browser back to a Tohyee page with
 * only a code saying what happened.
 */
export async function finishGoogleSignIn(request: Request): Promise<GoogleCallbackResult> {
  const url = new URL(request.url);
  const clear = clearBrowserCookie(request);
  const fallbackOrigin = await returnOrigin(request);
  const to = (origin: string, path: string, code?: GoogleSignInCode) => `${origin}${path}${code ? `${path.includes("?") ? "&" : "?"}google=${code}` : ""}`;

  try {
    assertSignInRate(request);
  } catch {
    return { location: to(fallbackOrigin, "/login", "busy"), cookies: [clear] };
  }

  const stateParam = url.searchParams.get("state") ?? "";
  const browser = readCookie(request, GOOGLE_BROWSER_COOKIE) ?? "";
  if (!stateParam || !browser || stateParam.length > 200 || browser.length > 200) return { location: to(fallbackOrigin, "/login", "expired"), cookies: [clear] };
  const claimed = await coreQuery<StateRow>(
    `update google_sign_in_states set used_at = now()
      where state_hash = $1 and browser_hash = $2 and used_at is null and created_at > now() - ($3::int * interval '1 minute')
      returning purpose, code_verifier, nonce, redirect_uri, next_path, user_id::text, session_id, setup_token_hash`,
    [sha256Hex(stateParam), sha256Hex(browser), STATE_MINUTES],
  );
  const row = claimed.rows[0];
  if (!row) return { location: to(fallbackOrigin, "/login", "expired"), cookies: [clear] };
  // Back to the address the trip started from (one Google accepted), where this browser's cookies are.
  const origin = new URL(row.redirect_uri).origin;
  const fail = (code: GoogleSignInCode): GoogleCallbackResult => ({ location: to(origin, FAILURE_PAGE[row.purpose], code), cookies: [clear] });

  try {
    await assertRemoteAllowed(request.headers);
  } catch {
    return fail("remote");
  }
  const providerError = url.searchParams.get("error");
  if (providerError) return fail(providerError === "access_denied" ? "cancelled" : "failed");
  const code = url.searchParams.get("code");
  if (!code) return fail("failed");
  const app = await googleSignInApp();
  if (!app) return fail("off");

  let identity: GoogleIdentity;
  try {
    const tokens = await exchangeCode("google", app, code, row.redirect_uri, undefined, { code_verifier: row.code_verifier });
    identity = verifyGoogleIdToken(tokens.idToken, { clientId: app.clientId, nonce: row.nonce, now: clock() });
  } catch (error) {
    if (error instanceof IdTokenError && /isn't verified/.test(error.message)) return fail("unverified");
    console.warn("[tohyee] Google sign-in didn't finish:", error instanceof Error ? error.message : error);
    return fail("failed");
  }

  try {
    if (row.purpose === "sign_in") return await signInWithGoogle(request, identity, origin, safeNextPath(row.next_path), clear);
    if (row.purpose === "setup") return await setupWithGoogle(request, identity, row.setup_token_hash!, origin, clear);
    return await linkGoogle(request, identity, row, origin, clear);
  } catch (error) {
    if (error instanceof Refusal) return fail(error.code);
    throw error;
  }
}

async function signInWithGoogle(request: Request, identity: GoogleIdentity, origin: string, next: string, clear: string): Promise<GoogleCallbackResult> {
  const found = await coreQuery<{ id: string; is_active: boolean }>(
    "select u.id::text, u.is_active from user_google_identities g join users u on u.id = g.user_id where g.google_sub = $1",
    [identity.sub],
  );
  const user = found.rows[0];
  if (!user) {
    await logSignIn(request, { email: identity.email, userId: null, step: "google", outcome: "refused", detail: "That Google account isn't linked to a login." });
    throw new Refusal("not_linked");
  }
  if (!user.is_active) {
    await logSignIn(request, { email: null, userId: user.id, step: "google", outcome: "refused", detail: "The login is turned off." });
    throw new Refusal("disabled");
  }
  const session = await withCoreTransaction(async (client) => {
    await client.query("update users set last_login_at = now() where id = $1", [user.id]);
    // Google's address for the account may have changed; the link is by its ID, so it stays.
    await client.query("update user_google_identities set email = $2, last_used_at = now() where user_id = $1", [user.id, identity.email]);
    return createSession(client, user.id, sessionMetaFrom(request), { method: "google" });
  });
  await logSignIn(request, { email: null, userId: user.id, step: "google", outcome: "signed_in" });
  return { location: `${origin}${next}`, cookies: [clear, sessionCookieHeader(request, session.token)] };
}

async function setupWithGoogle(request: Request, identity: GoogleIdentity, tokenHash: string, origin: string, clear: string): Promise<GoogleCallbackResult> {
  // A password nobody knows, so an old one stops working.
  const unusable = await hashPassword(randomToken());
  type Outcome = { ok: true; userId: string; token: string } | { ok: false; code: GoogleSignInCode; userId: string | null; detail: string };
  const done = await withCoreTransaction(async (client): Promise<Outcome> => {
    const found = await client.query<{ user_id: string; email: string; is_server_admin: boolean; display_name: string }>(
      `select l.user_id::text, u.email, u.is_server_admin, u.display_name from user_setup_links l join users u on u.id = l.user_id
        where l.token_hash = $1 and l.used_at is null and l.expires_at > now() and u.is_active
        for update of l, u`,
      [tokenHash],
    );
    const link = found.rows[0];
    if (!link) {
      return { ok: false, code: "link_used", userId: null, detail: "The setup link had expired or was used." };
    }
    if (link.is_server_admin) {
      return { ok: false, code: "server_admin", userId: link.user_id, detail: "Server admins keep a password." };
    }
    // The invitation is for one address: a forwarded link can't be taken over with someone else's Google account.
    if (identity.email !== link.email) {
      return { ok: false, code: "wrong_account", userId: link.user_id, detail: "A Google account with a different email address." };
    }
    const taken = await client.query("select 1 from user_google_identities where google_sub = $1 and user_id <> $2", [identity.sub, link.user_id]);
    if (taken.rows[0]) {
      return { ok: false, code: "taken", userId: link.user_id, detail: "That Google account is linked to another login." };
    }
    await client.query("update user_setup_links set used_at = now() where token_hash = $1", [tokenHash]);
    await client.query("delete from user_google_identities where user_id = $1", [link.user_id]);
    await client.query("insert into user_google_identities (user_id, google_sub, email, last_used_at) values ($1, $2, $3, now())", [link.user_id, identity.sub, identity.email]);
    await client.query(
      `update users set google_only = true, password_hash = $2, password_changed_at = now(), failed_login_count = 0, locked_until = null,
              totp_secret_ciphertext = null, totp_enabled_at = null, totp_last_step = null, totp_pending_ciphertext = null,
              last_login_at = now(), updated_at = now()
        where id = $1`,
      [link.user_id, unusable],
    );
    await client.query("delete from user_backup_codes where user_id = $1", [link.user_id]);
    await client.query("delete from sessions where user_id = $1", [link.user_id]);
    await revokeUserAiKeys(client, link.user_id);
    await writeAdminAuditEvent(client, { userId: link.user_id, email: link.email }, {
      eventType: "user.setup_completed",
      entityType: "user",
      entityId: link.user_id,
      details: { method: "google", googleEmail: identity.email },
    });
    const session = await createSession(client, link.user_id, sessionMetaFrom(request), { method: "google" });
    return { ok: true, userId: link.user_id, token: session.token };
  });
  if (!done.ok) {
    await logSignIn(request, { email: identity.email, userId: done.userId, step: "google", outcome: "refused", detail: `Setup link: ${done.detail}` });
    throw new Refusal(done.code);
  }
  await logSignIn(request, { email: null, userId: done.userId, step: "google", outcome: "signed_in" });
  return { location: `${origin}/operations`, cookies: [clear, sessionCookieHeader(request, done.token)] };
}

async function linkGoogle(request: Request, identity: GoogleIdentity, row: StateRow, origin: string, clear: string): Promise<GoogleCallbackResult> {
  // Still the same person, in the same session that started linking.
  const current = await getSessionUser(readCookie(request, SESSION_COOKIE));
  if (!current || current.user.id !== row.user_id || current.sessionId !== row.session_id) throw new Refusal("other_session");
  const user = current.user;
  const linked = await withCoreTransaction(async (client) => {
    const taken = await client.query<{ user_id: string }>("select user_id::text from user_google_identities where google_sub = $1", [identity.sub]);
    if (taken.rows[0] && taken.rows[0].user_id !== user.id) return "taken" as const;
    const mine = await client.query("select 1 from user_google_identities where user_id = $1", [user.id]);
    if (mine.rows[0]) return "failed" as const;
    await client.query("insert into user_google_identities (user_id, google_sub, email) values ($1, $2, $3)", [user.id, identity.sub, identity.email]);
    await writeAdminAuditEvent(client, { userId: user.id, email: user.email }, {
      eventType: "user.google_linked",
      entityType: "user",
      entityId: user.id,
      details: { googleEmail: identity.email },
    });
    return "linked" as const;
  });
  if (linked !== "linked") throw new Refusal(linked);
  await sendSecurityAlert(user.email, "a Google account was linked", [
    `The Google account ${identity.email} was linked to your Tohyee login, so it can now be used to sign in.`,
    "If this wasn't you, unlink it on Your account and change your password.",
  ]);
  return { location: `${origin}/operations/profile?google=linked`, cookies: [clear] };
}

// ---------------------------------------------------------------------------
// Your account, and server admins

export type GoogleSignInStatus = {
  /** Sign in with Google is on and set up on this server. */
  available: boolean;
  linked: { email: string; linkedAt: string; lastUsedAt: string | null } | null;
  /** Set up with Google from a setup link: no password. */
  googleOnly: boolean;
  /** Unlinking would still leave a way to sign in (a password, and two-step where it's needed). */
  canUnlink: boolean;
  /** This session was signed in with Google. */
  thisSessionViaGoogle: boolean;
};

export async function getGoogleSignInStatus(userId: string, sessionId: string): Promise<GoogleSignInStatus> {
  const found = await coreQuery<{ google_only: boolean; two_step_enabled: boolean; email: string | null; linked_at: string | null; last_used_at: string | null; method: string | null }>(
    `select u.google_only, u.totp_enabled_at is not null as two_step_enabled, g.email, g.linked_at, g.last_used_at,
            (select s.sign_in_method from sessions s where s.id = $2 and s.user_id = u.id) as method
       from users u left join user_google_identities g on g.user_id = u.id where u.id = $1`,
    [userId, sessionId],
  );
  const row = found.rows[0];
  if (!row) throw new NotFoundError("User not found.");
  return {
    available: await googleSignInAvailable(),
    linked: row.email && row.linked_at ? { email: row.email, linkedAt: new Date(row.linked_at).toISOString(), lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null } : null,
    googleOnly: row.google_only,
    canUnlink: !row.google_only && (row.two_step_enabled || !twoStepRequired()),
    thisSessionViaGoogle: row.method === "google",
  };
}

/** Unlinks your own Google account, if you'd still have a way to sign in. Google sessions (other than this one) end. */
export async function unlinkOwnGoogle(user: { id: string; email: string }, currentSessionId: string): Promise<void> {
  const status = await getGoogleSignInStatus(user.id, currentSessionId);
  if (!status.linked) throw new ConflictError("No Google account is linked to your login.");
  if (!status.canUnlink) {
    throw new ValidationError(
      status.googleOnly
        ? "You sign in with Google only, so unlinking it would leave you no way in. Ask your server admin for a setup link to choose a password first."
        : "Your password sign-in isn't fully set up (two-step sign-in), so unlinking Google would leave you no way in.",
    );
  }
  await withCoreTransaction(async (client) => {
    await client.query("delete from user_google_identities where user_id = $1", [user.id]);
    await client.query("delete from sessions where user_id = $1 and sign_in_method = 'google' and id <> $2", [user.id, currentSessionId]);
    await writeAdminAuditEvent(client, { userId: user.id, email: user.email }, {
      eventType: "user.google_unlinked",
      entityType: "user",
      entityId: user.id,
      details: { googleEmail: status.linked!.email },
    });
  });
  await sendSecurityAlert(user.email, "Google sign-in was unlinked", [`The Google account ${status.linked.email} can no longer be used to sign in to your Tohyee login.`]);
}

/**
 * A server admin removes someone's Google sign-in (a lost or taken-over
 * Google account). Their Google sessions end. Someone set up with Google
 * only then needs a setup link to choose a password.
 */
export async function removeGoogleSignIn(actor: AdminActor, userId: string): Promise<{ googleOnly: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new NotFoundError("User not found.");
  const result = await withCoreTransaction(async (client) => {
    const found = await client.query<{ email: string; google_only: boolean; google_email: string | null }>(
      "select u.email, u.google_only, g.email as google_email from users u left join user_google_identities g on g.user_id = u.id where u.id = $1 for update of u",
      [userId],
    );
    const row = found.rows[0];
    if (!row) throw new NotFoundError("User not found.");
    if (!row.google_email) throw new ConflictError(`${row.email} doesn't sign in with Google.`);
    await client.query("delete from user_google_identities where user_id = $1", [userId]);
    await client.query("delete from sessions where user_id = $1 and sign_in_method = 'google'", [userId]);
    await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
      eventType: "user.google_removed",
      entityType: "user",
      entityId: userId,
      details: { googleEmail: row.google_email },
    });
    return row;
  });
  await sendSecurityAlert(result.email, "Google sign-in was removed", [
    `A server admin (${actor.email}) removed Google sign-in (${result.google_email}) from your Tohyee login and signed out its Google sessions.`,
    result.google_only ? "Your server admin will send you a setup link to choose a password." : "You can still sign in with your password.",
  ]);
  return { googleOnly: result.google_only };
}
