import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import * as adminGoogleRoute from "@/app/api/admin/google-sign-in/route";
import * as adminGoogleCopyRoute from "@/app/api/admin/google-sign-in/copy/route";
import * as adminUserRoute from "@/app/api/admin/users/[userId]/route";
import * as adminUserGoogleRoute from "@/app/api/admin/users/[userId]/google/route";
import * as adminUsersRoute from "@/app/api/admin/users/route";
import * as googleStatusRoute from "@/app/api/auth/google/route";
import * as callbackRoute from "@/app/api/auth/google/callback/route";
import * as startRoute from "@/app/api/auth/google/start/route";
import * as unlinkRoute from "@/app/api/auth/google/unlink/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as sessionRoute from "@/app/api/auth/session/route";
import * as setupAccountRoute from "@/app/api/auth/setup-account/route";
import { pkceChallenge } from "@/lib/auth/google-oidc";
import type { SessionUser } from "@/lib/auth/sessions";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { saveMailSettings } from "@/lib/crm/mail/service";
import { coreQuery } from "@/lib/db/transactions";
import { type OutgoingEmail, setEmailSenderForTests, updateEmailSettings } from "@/lib/email/mailer";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  params,
  sessionCookieFor,
  startTestServer,
  TEST_PASSWORD,
  type TestServer,
} from "../helpers/test-server";

const noContext = undefined as unknown;
const CLIENT = "made-up-signin.apps.googleusercontent.com";
const SECRET = "made-up-google-secret";
const ORIGIN = "https://tohyee.test";

/** Requests as a browser reaching Tohyee on its https web address. */
function req(path: string, options: Parameters<typeof apiRequest>[1] = {}): Request {
  return apiRequest(path, { ...options, headers: { "x-forwarded-proto": "https", ...(options.headers ?? {}) } });
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

function cookiePart(response: Response, name: string): string {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))?.split(";")[0] ?? "";
}

// ---------------------------------------------------------------------------
// A made-up Google: the token endpoint only. Every call is checked as Google
// would: the one-time code, the client and secret, the redirect URI, and the
// PKCE verifier against the challenge the sign-in address carried.

type Issued = { claims: Record<string, unknown>; challenge: string; redirectUri: string };
const issued = new Map<string, Issued>();
const tokenCalls: URLSearchParams[] = [];

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", kid: "made-up" })}.${part(claims)}.${Buffer.from("made-up-signature").toString("base64url")}`;
}

/** Google signs someone in on the address Tohyee sent them to, and hands back `code`. */
function googleSignsIn(startUrl: string, code: string, account: { sub: string; email: string; email_verified?: unknown; [claim: string]: unknown }) {
  const url = new URL(startUrl);
  const now = Math.floor(Date.now() / 1000);
  issued.set(code, {
    claims: { iss: "https://accounts.google.com", aud: CLIENT, azp: CLIENT, nonce: url.searchParams.get("nonce"), iat: now, exp: now + 3600, email_verified: true, ...account },
    challenge: url.searchParams.get("code_challenge") ?? "",
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
  });
}

async function fakeGoogle(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  if (url.host !== "oauth2.googleapis.com" || url.pathname !== "/token") throw new Error(`Unexpected call to ${input}`);
  const form = new URLSearchParams(String(init?.body ?? ""));
  tokenCalls.push(form);
  const entry = issued.get(form.get("code") ?? "");
  const refuse = () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" }), { status: 400 });
  if (!entry) return refuse();
  issued.delete(form.get("code")!);
  if (form.get("grant_type") !== "authorization_code" || form.get("client_id") !== CLIENT || form.get("client_secret") !== SECRET) return refuse();
  if (form.get("redirect_uri") !== entry.redirectUri) return refuse();
  if (pkceChallenge(form.get("code_verifier") ?? "") !== entry.challenge) return refuse();
  return new Response(JSON.stringify({ access_token: "made-up-access", expires_in: 3599, scope: "openid email profile", token_type: "Bearer", id_token: idToken(entry.claims) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function start(payload: Record<string, unknown>, cookie?: string, headers?: Record<string, string>) {
  const response = await startRoute.POST(req("/api/auth/google/start", { method: "POST", body: payload, cookie, headers }), noContext);
  return { response, url: response.ok ? String((await body(response)).url) : "", browser: cookiePart(response, "tohyee_google_signin") };
}

async function callback(query: Record<string, string>, cookie: string) {
  const response = await callbackRoute.GET(req(`/api/auth/google/callback?${new URLSearchParams(query)}`, { cookie }));
  expect(response.status).toBe(303);
  return { location: response.headers.get("location") ?? "", session: cookiePart(response, "tohyee_session"), cookies: response.headers.getSetCookie() };
}

let codeCounter = 0;
/** The whole trip: start, Google signs `account` in, and back. */
async function viaGoogle(payload: Record<string, unknown>, account: { sub: string; email: string; [claim: string]: unknown }, cookie = "") {
  const started = await start(payload, cookie || undefined);
  expect(started.response.status).toBe(200);
  const code = `code-${++codeCounter}`;
  googleSignsIn(started.url, code, account);
  const state = new URL(started.url).searchParams.get("state")!;
  return callback({ state, code }, [started.browser, cookie].filter(Boolean).join("; "));
}

describeWithDatabase("Sign in with Google for invited people (#424; Google is a fake throughout)", () => {
  let server: TestServer;
  const originalKey = process.env.TOHYEE_SECRET_KEY;
  const sent: OutgoingEmail[] = [];
  let admin: SessionUser;
  let adminCookie = "";

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "google-sign-in-test-key-0123456789abcdef";
    server = await startTestServer();
    setMailFetchForTests(fakeGoogle);
    setEmailSenderForTests(async (message) => {
      sent.push(message);
    });
    admin = await createTestUser("admin@example.com", { serverAdmin: true, displayName: "Admin" });
    adminCookie = await sessionCookieFor(admin);
    await updateEmailSettings({ user: { id: admin.id, email: admin.email, isServerAdmin: true } }, { host: "smtp.gmail.com", port: 465, username: "books@example.com", password: "app-password" });
  });

  beforeEach(() => {
    sent.length = 0;
  });

  afterAll(async () => {
    setMailFetchForTests(null);
    setEmailSenderForTests(null);
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
  });

  const saveSettings = (payload: Record<string, unknown>, cookie = adminCookie, local = true) =>
    adminGoogleRoute.PUT(req("/api/admin/google-sign-in", { method: "PUT", body: payload, cookie, local }), noContext);

  async function invite(email: string, displayName: string): Promise<{ id: string; token: string }> {
    const created = await adminUsersRoute.POST(req("/api/admin/users", { method: "POST", cookie: adminCookie, body: { email, displayName } }), noContext);
    expect(created.status).toBe(201);
    const result = await body(created);
    const url = (result.setupLink as { url: string }).url;
    return { id: (result.user as { id: string }).id, token: decodeURIComponent(new URL(url).searchParams.get("token")!) };
  }

  it("is off until a server admin, on the server computer, sets up the Google app", async () => {
    expect((await start({ purpose: "sign_in" })).response.status).toBe(409);
    const member = await createTestUser("member@example.com");
    expect((await saveSettings({ enabled: true, clientId: CLIENT, clientSecret: SECRET }, await sessionCookieFor(member))).status).toBe(403);
    expect((await saveSettings({ enabled: true, clientId: CLIENT, clientSecret: SECRET }, adminCookie, false)).status).toBe(403);
    expect((await body(await saveSettings({ enabled: true, clientId: CLIENT }))).error).toMatch(/client ID and secret/);
    expect((await body(await saveSettings({ enabled: true, clientId: "not-a-google-client", clientSecret: SECRET }))).error).toMatch(/apps\.googleusercontent\.com/);

    const saved = await saveSettings({ enabled: true, clientId: CLIENT, clientSecret: SECRET });
    expect(saved.status).toBe(200);
    const { settings } = (await body(saved)) as { settings: Record<string, unknown> };
    expect(settings).toMatchObject({ enabled: true, ready: true, clientId: CLIENT, hasSecret: true });
    expect(JSON.stringify(settings)).not.toContain(SECRET);
    expect(settings.addresses).toEqual([{ label: "The address you're using now (only needed to sign in with Google this way)", uri: `${ORIGIN}/api/auth/google/callback`, problem: null }]);

    // A blank secret keeps the saved one.
    expect((await body(await saveSettings({ enabled: true, clientId: CLIENT, clientSecret: "" }))).settings).toMatchObject({ ready: true });
    const audit = await coreQuery<{ details: Record<string, unknown> }>("select details from admin_audit_events where event_type = 'server.google_sign_in_updated' order by id desc limit 1");
    expect(audit.rows[0].details).toMatchObject({ enabled: true, clientId: CLIENT, secretChanged: false });
  });

  it("says when the server's address can't be used with Google", async () => {
    const onLan = await startRoute.POST(apiRequest("/api/auth/google/start", { method: "POST", body: { purpose: "sign_in" }, origin: "http://192.168.1.20:3000", headers: { host: "192.168.1.20:3000" } }), noContext);
    expect(onLan.status).toBe(400);
    expect((await body(onLan)).error).toMatch(/network address/);
    const shown = await adminGoogleRoute.GET(apiRequest("/api/admin/google-sign-in", { cookie: adminCookie, headers: { host: "192.168.1.20:3000" } }), noContext);
    expect(((await body(shown)).settings as { addresses: Array<{ problem: string | null }> }).addresses[0].problem).toMatch(/network address/);
  });

  it("can use the Google app an organisation already has, for an admin of that organisation only", async () => {
    await createTestOrganisation(admin, "google-app-org");
    await inOrganisation("google-app-org", { userId: admin.id, email: admin.email }, (tx) => saveMailSettings(tx, { googleClientId: "org-app.apps.googleusercontent.com", googleClientSecret: "org-secret" }));
    const outsider = await createTestUser("outsider-admin@example.com", { serverAdmin: true });
    const refused = await adminGoogleCopyRoute.POST(req("/api/admin/google-sign-in/copy", { method: "POST", cookie: await sessionCookieFor(outsider), body: { organisationId: "google-app-org" } }), noContext);
    expect(refused.status).toBe(404);
    const copied = await adminGoogleCopyRoute.POST(req("/api/admin/google-sign-in/copy", { method: "POST", cookie: adminCookie, body: { organisationId: "google-app-org" } }), noContext);
    expect(copied.status).toBe(200);
    expect((await body(copied)).settings).toMatchObject({ clientId: "org-app.apps.googleusercontent.com", copiedFromOrganisationId: "google-app-org", ready: true });
    // Back to the test's own app for the rest.
    expect((await saveSettings({ enabled: true, clientId: CLIENT, clientSecret: SECRET })).status).toBe(200);
  });

  it("an invited person continues with Google from their setup link, with the invited address only", async () => {
    const kim = await invite("kim@example.com", "Kim");
    expect(await body(await setupAccountRoute.GET(req(`/api/auth/setup-account?token=${encodeURIComponent(kim.token)}`), noContext))).toMatchObject({ valid: true, googleAvailable: true });
    const started = await start({ purpose: "setup", token: kim.token });
    const url = new URL(started.url);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("login_hint")).toBe("kim@example.com");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
    expect(started.browser).toMatch(/^tohyee_google_signin=/);
    expect(started.response.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax; Max-Age=600; Secure/);

    // A forwarded link, opened by someone with another Google account: refused, and the link still works for Kim.
    const forwarded = await viaGoogle({ purpose: "setup", token: kim.token }, { sub: "sub-stranger", email: "stranger@example.com" });
    expect(forwarded.location).toBe(`${ORIGIN}/login/setup-account?google=wrong_account`);
    expect(forwarded.session).toBe("");
    // Google says the address isn't verified: refused too.
    expect((await viaGoogle({ purpose: "setup", token: kim.token }, { sub: "sub-kim", email: "kim@example.com", email_verified: false })).location).toBe(`${ORIGIN}/login/setup-account?google=unverified`);
    expect((await body(await setupAccountRoute.GET(req(`/api/auth/setup-account?token=${encodeURIComponent(kim.token)}`), noContext))).valid).toBe(true);

    const done = await viaGoogle({ purpose: "setup", token: kim.token }, { sub: "sub-kim", email: "Kim@Example.com" });
    expect(done.location).toBe(`${ORIGIN}/operations`);
    expect(done.cookies.some((cookie) => cookie.startsWith("tohyee_google_signin=;") && cookie.includes("Max-Age=0"))).toBe(true);
    // Fully signed in, without Tohyee's authenticator app.
    const session = await sessionRoute.GET(req("/api/auth/session", { cookie: done.session }), noContext);
    expect(session.status).toBe(200);
    expect((await body(session)).user).toMatchObject({ email: "kim@example.com" });
    const row = await coreQuery<{ google_only: boolean; google_sub: string; used: boolean }>(
      `select u.google_only, g.google_sub, (select bool_and(used_at is not null) from user_setup_links l where l.user_id = u.id) as used
         from users u join user_google_identities g on g.user_id = u.id where u.id = $1`,
      [kim.id],
    );
    expect(row.rows[0]).toEqual({ google_only: true, google_sub: "sub-kim", used: true });
    expect((await coreQuery("select 1 from sessions where user_id = $1 and sign_in_method = 'google'", [kim.id])).rowCount).toBe(1);
    // The PKCE verifier went to Google with the code.
    expect(tokenCalls.at(-1)?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    // The link is used up.
    expect((await start({ purpose: "setup", token: kim.token })).response.status).toBe(401);
    const events = await coreQuery<{ step: string; outcome: string }>("select step, outcome from sign_in_events where user_id = $1 order by sign_in_events.id", [kim.id]);
    expect(events.rows.map((event) => `${event.step}:${event.outcome}`)).toEqual(["google:refused", "google:signed_in"]);

    // Kim's Google-only login has no password to try.
    expect((await loginRoute.POST(req("/api/auth/login", { method: "POST", body: { email: "kim@example.com", password: TEST_PASSWORD } }), noContext)).status).toBe(401);
  });

  it("signs a linked person in by Google's account ID, never by email address alone", async () => {
    // Kim's Google address changed: still Kim, by the account ID.
    const changed = await viaGoogle({ purpose: "sign_in", next: "/operations/invoices" }, { sub: "sub-kim", email: "kim.new@example.com" });
    expect(changed.location).toBe(`${ORIGIN}/operations/invoices`);
    expect((await body(await sessionRoute.GET(req("/api/auth/session", { cookie: changed.session }), noContext))).user).toMatchObject({ email: "kim@example.com" });
    expect((await coreQuery<{ email: string }>("select email from user_google_identities where google_sub = 'sub-kim'")).rows[0].email).toBe("kim.new@example.com");

    // Someone else now has a Google account with Kim's old address: not Kim.
    const reused = await viaGoogle({ purpose: "sign_in" }, { sub: "sub-someone-else", email: "kim@example.com" });
    expect(reused.location).toBe(`${ORIGIN}/login?google=not_linked`);
    expect(reused.session).toBe("");

    // A Google account nobody invited can't make a login.
    const before = (await coreQuery<{ count: string }>("select count(*)::text as count from users")).rows[0].count;
    const uninvited = await viaGoogle({ purpose: "sign_in" }, { sub: "sub-uninvited", email: "uninvited@example.com" });
    expect(uninvited.location).toBe(`${ORIGIN}/login?google=not_linked`);
    expect((await coreQuery<{ count: string }>("select count(*)::text as count from users")).rows[0].count).toBe(before);
    expect((await coreQuery<{ outcome: string }>("select outcome from sign_in_events where email = 'uninvited@example.com'")).rows).toEqual([{ outcome: "refused" }]);
  });

  it("never sends people to another site after signing in", async () => {
    for (const next of ["https://evil.example/operations", "//evil.example/operations", "/operations/../../evil"]) {
      const result = await viaGoogle({ purpose: "sign_in", next }, { sub: "sub-kim", email: "kim@example.com" });
      expect(result.location.startsWith(`${ORIGIN}/`)).toBe(true);
      expect(result.location).not.toContain("evil");
    }
  });

  it("refuses a callback that this browser didn't start, or that was used already (no sign-in CSRF)", async () => {
    // An attacker starts a sign-in with their own Google account and sends someone the callback link.
    const attacker = await start({ purpose: "sign_in" });
    googleSignsIn(attacker.url, "attacker-code", { sub: "sub-kim", email: "kim@example.com" });
    const state = new URL(attacker.url).searchParams.get("state")!;
    const victim = await start({ purpose: "sign_in" });
    expect((await callback({ state, code: "attacker-code" }, "")).location).toBe(`${ORIGIN}/login?google=expired`);
    expect((await callback({ state, code: "attacker-code" }, victim.browser)).location).toBe(`${ORIGIN}/login?google=expired`);
    // The rightful browser still can, once.
    const ok = await callback({ state, code: "attacker-code" }, attacker.browser);
    expect(ok.session).not.toBe("");
    expect((await callback({ state, code: "attacker-code" }, attacker.browser)).location).toBe(`${ORIGIN}/login?google=expired`);
    // A made-up state.
    expect((await callback({ state: "made-up-state-made-up-state-made-up-000", code: "x" }, attacker.browser)).location).toBe(`${ORIGIN}/login?google=expired`);
    // Expired after 10 minutes.
    const old = await start({ purpose: "sign_in" });
    googleSignsIn(old.url, "old-code", { sub: "sub-kim", email: "kim@example.com" });
    await coreQuery("update google_sign_in_states set created_at = now() - interval '11 minutes' where used_at is null");
    expect((await callback({ state: new URL(old.url).searchParams.get("state")!, code: "old-code" }, old.browser)).location).toBe(`${ORIGIN}/login?google=expired`);
  });

  it("checks Google's answer: a cancelled sign-in, a wrong nonce or app, and the PKCE verifier", async () => {
    const cancelled = await start({ purpose: "sign_in" });
    expect((await callback({ state: new URL(cancelled.url).searchParams.get("state")!, error: "access_denied" }, cancelled.browser)).location).toBe(`${ORIGIN}/login?google=cancelled`);
    expect((await viaGoogle({ purpose: "sign_in" }, { sub: "sub-kim", email: "kim@example.com", nonce: "a-different-nonce-0123456789" })).location).toBe(`${ORIGIN}/login?google=failed`);
    expect((await viaGoogle({ purpose: "sign_in" }, { sub: "sub-kim", email: "kim@example.com", aud: "other.apps.googleusercontent.com", azp: "other.apps.googleusercontent.com" })).location).toBe(`${ORIGIN}/login?google=failed`);
    expect((await viaGoogle({ purpose: "sign_in" }, { sub: "sub-kim", email: "kim@example.com", iss: "https://accounts.example.com" })).location).toBe(`${ORIGIN}/login?google=failed`);
    expect((await viaGoogle({ purpose: "sign_in" }, { sub: "sub-kim", email: "kim@example.com", exp: Math.floor(Date.now() / 1000) - 3600 })).location).toBe(`${ORIGIN}/login?google=failed`);
    // A code issued for one sign-in can't finish another (its PKCE challenge is different).
    const first = await start({ purpose: "sign_in" });
    const second = await start({ purpose: "sign_in" });
    googleSignsIn(first.url, "first-code", { sub: "sub-kim", email: "kim@example.com" });
    expect((await callback({ state: new URL(second.url).searchParams.get("state")!, code: "first-code" }, second.browser)).location).toBe(`${ORIGIN}/login?google=failed`);
  });

  it("people with a password link Google from Your account, with their password again and in the same session", async () => {
    const ana = await createTestUser("ana@example.com", { displayName: "Ana" });
    const anaCookie = await sessionCookieFor(ana);
    expect((await start({ purpose: "link" })).response.status).toBe(401);
    expect((await body((await start({ purpose: "link" }, anaCookie)).response)).error).toMatch(/Enter your password/);
    expect((await body((await start({ purpose: "link", password: "wrong-password-123" }, anaCookie)).response)).error).toMatch(/isn't right/);

    // Signed in as someone else by the time Google sends the browser back: not linked.
    const started = await start({ purpose: "link", password: TEST_PASSWORD }, anaCookie);
    googleSignsIn(started.url, "ana-code-1", { sub: "sub-ana", email: "ana.personal@example.com" });
    const other = await sessionCookieFor(await createTestUser("other@example.com"));
    const swapped = await callback({ state: new URL(started.url).searchParams.get("state")!, code: "ana-code-1" }, `${started.browser}; ${other}`);
    expect(swapped.location).toBe(`${ORIGIN}/operations/profile?google=other_session`);
    expect((await coreQuery("select 1 from user_google_identities where google_sub = 'sub-ana'")).rowCount).toBe(0);

    // A Google account already linked to someone else (Kim's).
    expect((await viaGoogle({ purpose: "link", password: TEST_PASSWORD }, { sub: "sub-kim", email: "kim@example.com" }, anaCookie)).location).toBe(`${ORIGIN}/operations/profile?google=taken`);

    const linked = await viaGoogle({ purpose: "link", password: TEST_PASSWORD }, { sub: "sub-ana", email: "ana.personal@example.com" }, anaCookie);
    expect(linked.location).toBe(`${ORIGIN}/operations/profile?google=linked`);
    expect(linked.session).toBe("");
    expect(sent.find((email) => email.to === "ana@example.com")?.subject).toBe("Tohyee: a Google account was linked");
    const status = (await body(await googleStatusRoute.GET(req("/api/auth/google", { cookie: anaCookie }), noContext))).google;
    expect(status).toMatchObject({ available: true, linked: { email: "ana.personal@example.com" }, googleOnly: false, canUnlink: true, thisSessionViaGoogle: false });
    expect((await start({ purpose: "link", password: TEST_PASSWORD }, anaCookie)).response.status).toBe(409);

    // Ana can now sign in either way.
    const viaGoogleSignIn = await viaGoogle({ purpose: "sign_in" }, { sub: "sub-ana", email: "ana.personal@example.com" });
    expect(viaGoogleSignIn.session).not.toBe("");
    expect((await loginRoute.POST(req("/api/auth/login", { method: "POST", body: { email: "ana@example.com", password: TEST_PASSWORD } }), noContext)).status).toBe(200);

    // Unlinking ends her Google sessions, but not this one.
    const unlinked = await unlinkRoute.POST(req("/api/auth/google/unlink", { method: "POST", cookie: anaCookie }), noContext);
    expect(unlinked.status).toBe(200);
    expect((await sessionRoute.GET(req("/api/auth/session", { cookie: viaGoogleSignIn.session }), noContext)).status).toBe(401);
    expect((await sessionRoute.GET(req("/api/auth/session", { cookie: anaCookie }), noContext)).status).toBe(200);
    expect((await viaGoogle({ purpose: "sign_in" }, { sub: "sub-ana", email: "ana.personal@example.com" })).location).toBe(`${ORIGIN}/login?google=not_linked`);
  });

  it("someone set up with Google only can't unlink it, and can't be made a server admin", async () => {
    const kimSession = (await viaGoogle({ purpose: "sign_in" }, { sub: "sub-kim", email: "kim@example.com" })).session;
    const refused = await unlinkRoute.POST(req("/api/auth/google/unlink", { method: "POST", cookie: kimSession }), noContext);
    expect(refused.status).toBe(400);
    expect((await body(refused)).error).toMatch(/no way in/);
    const kimId = (await coreQuery<{ id: string }>("select id::text from users where email = 'kim@example.com'")).rows[0].id;
    const admin2 = await adminUserRoute.PATCH(req(`/api/admin/users/${kimId}`, { method: "PATCH", cookie: adminCookie, body: { isServerAdmin: true } }), params({ userId: kimId }));
    expect(admin2.status).toBe(400);
    expect((await body(admin2)).error).toMatch(/Server admins always keep a password/);
  });

  it("a server admin's setup link always asks for a password", async () => {
    const created = await adminUsersRoute.POST(req("/api/admin/users", { method: "POST", cookie: adminCookie, body: { email: "second-admin@example.com", displayName: "Second", isServerAdmin: true } }), noContext);
    const token = decodeURIComponent(new URL(((await body(created)).setupLink as { url: string }).url).searchParams.get("token")!);
    expect((await body(await setupAccountRoute.GET(req(`/api/auth/setup-account?token=${encodeURIComponent(token)}`), noContext))).googleAvailable).toBe(false);
    const started = await start({ purpose: "setup", token });
    expect(started.response.status).toBe(403);
  });

  it("disabling a login, or a server admin removing Google, ends Google sign-in", async () => {
    const kimId = (await coreQuery<{ id: string }>("select id::text from users where email = 'kim@example.com'")).rows[0].id;
    const session = (await viaGoogle({ purpose: "sign_in" }, { sub: "sub-kim", email: "kim@example.com" })).session;
    expect((await adminUserRoute.PATCH(req(`/api/admin/users/${kimId}`, { method: "PATCH", cookie: adminCookie, body: { isActive: false } }), params({ userId: kimId }))).status).toBe(200);
    expect((await sessionRoute.GET(req("/api/auth/session", { cookie: session }), noContext)).status).toBe(401);
    expect((await viaGoogle({ purpose: "sign_in" }, { sub: "sub-kim", email: "kim@example.com" })).location).toBe(`${ORIGIN}/login?google=disabled`);
    expect((await adminUserRoute.PATCH(req(`/api/admin/users/${kimId}`, { method: "PATCH", cookie: adminCookie, body: { isActive: true } }), params({ userId: kimId }))).status).toBe(200);

    const again = (await viaGoogle({ purpose: "sign_in" }, { sub: "sub-kim", email: "kim@example.com" })).session;
    const removed = await adminUserGoogleRoute.DELETE(req(`/api/admin/users/${kimId}/google`, { method: "DELETE", cookie: adminCookie }), params({ userId: kimId }));
    expect(await body(removed)).toEqual({ googleOnly: true });
    expect((await sessionRoute.GET(req("/api/auth/session", { cookie: again }), noContext)).status).toBe(401);
    expect((await viaGoogle({ purpose: "sign_in" }, { sub: "sub-kim", email: "kim@example.com" })).location).toBe(`${ORIGIN}/login?google=not_linked`);
    expect(sent.some((email) => email.to === "kim@example.com" && email.subject === "Tohyee: Google sign-in was removed")).toBe(true);
  });

  it("keeps the per-address sign-in limit", async () => {
    const from = { "x-forwarded-for": "203.0.113.77" };
    let last = 0;
    for (let attempt = 0; attempt < 31; attempt += 1) last = (await start({ purpose: "sign_in" }, undefined, from)).response.status;
    expect(last).toBe(429);
    const limited = await callbackRoute.GET(req("/api/auth/google/callback?state=x&code=y", { headers: from }));
    expect(limited.headers.get("location")).toBe(`${ORIGIN}/login?google=busy`);
  });

  it("turning it off stops Google sign-ins straight away", async () => {
    const started = await start({ purpose: "sign_in" });
    expect((await saveSettings({ enabled: false })).status).toBe(200);
    googleSignsIn(started.url, "off-code", { sub: "sub-ana", email: "ana@example.com" });
    expect((await callback({ state: new URL(started.url).searchParams.get("state")!, code: "off-code" }, started.browser)).location).toBe(`${ORIGIN}/login?google=off`);
    expect((await start({ purpose: "sign_in" })).response.status).toBe(409);
  });
});
