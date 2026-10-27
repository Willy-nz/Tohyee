import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import * as adminUserPasskeysRoute from "@/app/api/admin/users/[userId]/passkeys/route";
import * as adminUserRoute from "@/app/api/admin/users/[userId]/route";
import * as adminTwoStepRoute from "@/app/api/admin/users/[userId]/two-step/route";
import * as passwordRoute from "@/app/api/auth/password/route";
import * as passkeyRoute from "@/app/api/auth/passkeys/[passkeyId]/route";
import * as optionsRoute from "@/app/api/auth/passkeys/options/route";
import * as passkeysRoute from "@/app/api/auth/passkeys/route";
import * as signInOptionsRoute from "@/app/api/auth/passkeys/sign-in/options/route";
import * as signInRoute from "@/app/api/auth/passkeys/sign-in/route";
import * as sessionRoute from "@/app/api/auth/session/route";
import { setPasskeyClockForTests } from "@/lib/auth/passkeys";
import { forgetRemotePauseCache, resumeRemoteAccess } from "@/lib/auth/remote-pause";
import { createSession, type SessionUser } from "@/lib/auth/sessions";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { type OutgoingEmail, setEmailSenderForTests, updateEmailSettings } from "@/lib/email/mailer";
import { authenticateFarmAppKey, createFarmAppKey } from "@/lib/farm-apps/keys";
import { writeServerValue } from "@/lib/server-settings";
import { SoftAuthenticator } from "../helpers/soft-authenticator";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  params,
  sessionCookieFor,
  startTestServer,
  TEST_PASSWORD,
  type TestServer,
} from "../helpers/test-server";

/*
 * Sign in with a passkey (#450, decisions 885-899). The passkeys are made and
 * used by a software authenticator (tests/helpers/soft-authenticator.ts) with
 * real P-256 keys and signatures, not a phone. People and addresses are made
 * up.
 */

const HOST = "books.example.nz";
const ORIGIN = `https://${HOST}`;
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

/** A browser on Tohyee's web address. */
function req(path: string, options: Parameters<typeof apiRequest>[1] = {}): Request {
  return apiRequest(path, { ...options, origin: options.origin === undefined ? ORIGIN : options.origin, headers: { host: HOST, "x-forwarded-proto": "https", ...(options.headers ?? {}) } });
}

async function body(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

function cookiePart(response: Response, name: string): string {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))?.split(";")[0] ?? "";
}

type CreationOptions = Parameters<SoftAuthenticator["create"]>[0];
type RequestOptions = Parameters<SoftAuthenticator["get"]>[0];

async function startAdding(cookie: string, password: unknown = TEST_PASSWORD, host = HOST) {
  const response = await optionsRoute.POST(req("/api/auth/passkeys/options", { method: "POST", cookie, body: { password }, headers: { host }, origin: `https://${host}` }), noContext);
  return { response, options: response.ok ? ((await body(response)).options as CreationOptions & Json) : null };
}

async function finishAdding(cookie: string, response: unknown, name = "Jess's iPhone") {
  return passkeysRoute.POST(req("/api/auth/passkeys", { method: "POST", cookie, body: { response, name } }), noContext);
}

async function addPasskey(cookie: string, authenticator: SoftAuthenticator, name = "Jess's iPhone") {
  const started = await startAdding(cookie);
  expect(started.response.status).toBe(200);
  const done = await finishAdding(cookie, authenticator.create(started.options!, ORIGIN), name);
  expect(done.status).toBe(201);
  return (await body(done)).passkey as { id: string; name: string };
}

async function signInOptions(browser = "") {
  const response = await signInOptionsRoute.POST(req("/api/auth/passkeys/sign-in/options", { method: "POST", cookie: browser || undefined }), noContext);
  expect(response.status).toBe(200);
  return { options: (await body(response)).options as RequestOptions & Json, browser: cookiePart(response, "tohyee_passkey") || browser, setCookie: response.headers.get("set-cookie") ?? "" };
}

async function signIn(authenticator: SoftAuthenticator, overrides: Parameters<SoftAuthenticator["get"]>[2] = {}) {
  const { options, browser } = await signInOptions();
  const assertion = authenticator.get(options, ORIGIN, overrides);
  const response = await signInRoute.POST(req("/api/auth/passkeys/sign-in", { method: "POST", cookie: browser, body: { response: assertion } }), noContext);
  return { response, assertion, browser, options, session: cookiePart(response, "tohyee_session") };
}

async function signedIn(session: string): Promise<boolean> {
  return (await sessionRoute.GET(req("/api/auth/session", { cookie: session }), noContext)).status === 200;
}

describeWithDatabase("Sign in with a passkey (#450; a software authenticator throughout)", () => {
  let server: TestServer;
  const originalKey = process.env.TOHYEE_SECRET_KEY;
  const sent: OutgoingEmail[] = [];
  let admin: SessionUser;
  let adminCookie = "";

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "passkey-test-key-0123456789abcdef-0123";
    server = await startTestServer();
    setEmailSenderForTests(async (message) => {
      sent.push(message);
    });
    admin = await createTestUser("admin@example.com", { serverAdmin: true, displayName: "Admin" });
    adminCookie = await sessionCookieFor(admin);
    await updateEmailSettings({ user: { id: admin.id, email: admin.email, isServerAdmin: true } }, { host: "smtp.gmail.com", port: 465, username: "books@example.com", password: "app-password" });
    await withCoreTransaction((client) => writeServerValue(client, "remote_access", { enabled: true, publicUrl: ORIGIN }, "test"));
  });

  beforeEach(() => {
    sent.length = 0;
    setPasskeyClockForTests(null);
  });

  afterAll(async () => {
    setPasskeyClockForTests(null);
    setEmailSenderForTests(null);
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
  });

  it("adds a passkey after the password again, then signs in with it as a full, two-step sign-in", async () => {
    const jess = await createTestUser("jess@example.com", { displayName: "Jess" });
    const cookie = await sessionCookieFor(jess);
    const phone = new SoftAuthenticator({ synced: true });

    // The password is needed, and a wrong one counts towards the lockout like a sign-in.
    expect((await body((await startAdding(cookie, "")).response)).error).toMatch(/Enter your password/);
    const wrong = await startAdding(cookie, "not-my-password");
    expect(wrong.response.status).toBe(400);
    expect((await coreQuery<{ n: number }>("select failed_login_count as n from users where id = $1", [jess.id])).rows[0].n).toBe(1);

    const started = await startAdding(cookie);
    expect(started.response.status).toBe(200);
    const options = started.options!;
    expect((await coreQuery<{ n: number }>("select failed_login_count as n from users where id = $1", [jess.id])).rows[0].n).toBe(0);
    expect(options).toMatchObject({
      rp: { id: HOST, name: "Tohyee" },
      user: { name: "jess@example.com", displayName: "Jess" },
      attestation: "none",
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    });
    // The passkey carries a random ID, not the login's own.
    const handle = (options.user as { id: string }).id;
    expect(handle).not.toContain(jess.id);
    expect((await coreQuery<{ handle: string }>("select passkey_user_handle as handle from users where id = $1", [jess.id])).rows[0].handle).toBe(handle);

    // A name is needed.
    const response = phone.create(options, ORIGIN);
    expect((await finishAdding(cookie, response, "  ")).status).toBe(400);
    const added = await finishAdding(cookie, response, "Jess's iPhone");
    expect(added.status).toBe(201);
    expect((await body(added)).passkey).toMatchObject({ name: "Jess's iPhone", rpId: HOST, synced: true, backedUp: true });
    // Only the public key is kept.
    const row = (await coreQuery<{ public_key: Buffer; rp_id: string; transports: string[] }>("select public_key, rp_id, transports from user_passkeys where user_id = $1", [jess.id])).rows[0];
    expect(row.rp_id).toBe(HOST);
    expect(row.transports).toEqual(["internal", "hybrid"]);
    expect(row.public_key.length).toBeGreaterThan(60);
    expect(sent.map((email) => [email.to, email.subject])).toContainEqual(["jess@example.com", "Tohyee: a passkey was added"]);
    expect((await coreQuery("select 1 from admin_audit_events where event_type = 'user.passkey_added' and entity_id = $1", [jess.id])).rowCount).toBe(1);

    // The same answer again: the challenge was used.
    expect((await finishAdding(cookie, response, "Again")).status).toBe(400);

    // Sign in: no email, no list of passkeys, the face or finger required.
    const { options: request, setCookie } = await signInOptions();
    expect(request).toMatchObject({ rpId: HOST, userVerification: "required" });
    expect(request.allowCredentials ?? []).toEqual([]);
    expect(setCookie).toMatch(/^tohyee_passkey=[A-Za-z0-9_-]{43}; Path=\/api\/auth\/passkeys\/sign-in; HttpOnly; SameSite=Strict; Max-Age=300; Secure$/);
    const signed = await signIn(phone);
    expect(signed.response.status).toBe(200);
    expect(await body(signed.response)).toMatchObject({ user: { email: "jess@example.com" }, stage: "full" });
    expect(await signedIn(signed.session)).toBe(true);
    const session = (await coreQuery<{ sign_in_method: string; two_step_pending: boolean; passkey_id: string }>("select sign_in_method, two_step_pending, passkey_id::text from sessions where user_id = $1 and passkey_id is not null", [jess.id])).rows[0];
    expect(session).toMatchObject({ sign_in_method: "passkey", two_step_pending: false });
    const events = await coreQuery<{ email: string; step: string; outcome: string; detail: string }>("select email, step, outcome, detail from sign_in_events where user_id = $1 order by sign_in_events.id", [jess.id]);
    expect(events.rows.at(-1)).toEqual({ email: "jess@example.com", step: "passkey", outcome: "signed_in", detail: 'Passkey "Jess\'s iPhone"' });
    expect((await coreQuery<{ last_used_at: Date | null }>("select last_used_at from user_passkeys where user_id = $1", [jess.id])).rows[0].last_used_at).not.toBeNull();

    // Your account lists it, marked as the one this session used.
    const status = await body(await passkeysRoute.GET(req("/api/auth/passkeys", { cookie: signed.session }), noContext));
    expect(status.passkeys).toMatchObject({ rpId: HOST, problem: null, needsPassword: true, passkeys: [{ name: "Jess's iPhone", thisSession: true, place: `at ${HOST}` }] });
  });

  it("refuses replayed, cross-browser, late, cross-address and unverified answers", async () => {
    const kim = await createTestUser("kim@example.com");
    const phone = new SoftAuthenticator();
    await addPasskey(await sessionCookieFor(kim), phone, "Kim's phone");

    // Replayed: the same signed answer, sent again from the same browser.
    const first = await signIn(phone);
    expect(first.response.status).toBe(200);
    const replay = await signInRoute.POST(req("/api/auth/passkeys/sign-in", { method: "POST", cookie: first.browser, body: { response: first.assertion } }), noContext);
    expect(replay.status).toBe(401);
    expect((await body(replay)).error).toMatch(/took too long, or was already used/);

    // Another browser: the challenge is tied to the cookie of the browser that asked for it.
    const { options, browser } = await signInOptions();
    const elsewhere = await signInRoute.POST(req("/api/auth/passkeys/sign-in", { method: "POST", cookie: "tohyee_passkey=" + "x".repeat(43), body: { response: phone.get(options, ORIGIN) } }), noContext);
    expect(elsewhere.status).toBe(401);
    // ...and it wasn't used up by that.
    const fine = await signInRoute.POST(req("/api/auth/passkeys/sign-in", { method: "POST", cookie: browser, body: { response: phone.get(options, ORIGIN) } }), noContext);
    expect(fine.status).toBe(200);

    // Late: more than 5 minutes after the challenge.
    const late = await signInOptions();
    setPasskeyClockForTests(() => new Date(Date.now() + 6 * 60 * 1000));
    const tooLate = await signInRoute.POST(req("/api/auth/passkeys/sign-in", { method: "POST", cookie: late.browser, body: { response: phone.get(late.options, ORIGIN) } }), noContext);
    expect(tooLate.status).toBe(401);
    setPasskeyClockForTests(null);

    // Another site's address: a lookalike site can't use an answer meant for itself, or pass its own off.
    expect((await signIn(phone, { rpId: "books.example.com" })).response.status).toBe(401);
    const lookalike = await signInOptions();
    const fromLookalike = await signInRoute.POST(
      req("/api/auth/passkeys/sign-in", { method: "POST", cookie: lookalike.browser, body: { response: phone.get(lookalike.options, "https://books-example.nz") } }),
      noContext,
    );
    expect(fromLookalike.status).toBe(401);

    // The face or finger check skipped: refused.
    expect((await signIn(phone, { userVerified: false })).response.status).toBe(401);
    // Another challenge than the one asked for (made up): refused.
    expect((await signIn(phone, { challenge: "A".repeat(43) })).response.status).toBe(401);

    const outcomes = await coreQuery<{ outcome: string }>("select outcome from sign_in_events where user_id = $1 and step = 'passkey'", [kim.id]);
    expect(outcomes.rows.filter((row) => row.outcome === "failed").length).toBeGreaterThanOrEqual(3);
  });

  it("refuses a passkey that claims to be another login's, or one that's unknown, without saying who has a login", async () => {
    const ana = await createTestUser("ana@example.com");
    const ben = await createTestUser("ben@example.com");
    const anasPhone = new SoftAuthenticator();
    const bensPhone = new SoftAuthenticator();
    await addPasskey(await sessionCookieFor(ana), anasPhone, "Ana's phone");
    await addPasskey(await sessionCookieFor(ben), bensPhone, "Ben's phone");

    // Ana's passkey, sent with Ben's ID: refused, and not signed in as either.
    const swapped = await signIn(anasPhone, { userHandle: bensPhone.passkeys[0].userHandle });
    expect(swapped.response.status).toBe(401);
    expect(swapped.session).toBe("");
    // A passkey sign-in must say whose it is (a discoverable passkey always does).
    expect((await signIn(anasPhone, { userHandle: null })).response.status).toBe(401);
    const refused = await coreQuery<{ outcome: string }>("select outcome from sign_in_events where user_id = $1 and step = 'passkey'", [ana.id]);
    expect(refused.rows.map((row) => row.outcome)).toContain("refused");

    // A passkey Tohyee doesn't know: the browser is told it can forget it.
    const stranger = new SoftAuthenticator();
    stranger.create({ challenge: "x".repeat(43), rp: { id: HOST }, user: { id: "made-up-handle-0123456789" } }, ORIGIN);
    const unknown = await signIn(stranger);
    expect(unknown.response.status).toBe(401);
    expect(await body(unknown.response)).toMatchObject({ code: "unknown_passkey", details: { unknownCredential: { rpId: HOST, credentialId: stranger.passkeys[0].id } } });

    // The sign-in page asks for nothing that could tell who has a login: the options are the same for everyone.
    const one = (await signInOptions()).options;
    const two = (await signInOptions()).options;
    expect(Object.keys(one).sort()).toEqual(Object.keys(two).sort());
    expect(JSON.stringify(one)).not.toMatch(/ana|ben|example\.com/);
  });

  it("checks the use count: refuses one that goes backwards, flags one that doesn't go up", async () => {
    const lou = await createTestUser("lou@example.com");
    const key = new SoftAuthenticator({ counting: true });
    await addPasskey(await sessionCookieFor(lou), key, "Lou's security key");
    expect((await signIn(key)).response.status).toBe(200); // 2
    expect((await signIn(key)).response.status).toBe(200); // 3
    expect((await coreQuery<{ n: string }>("select sign_count::text as n from user_passkeys where user_id = $1", [lou.id])).rows[0].n).toBe("3");

    // The same count again: allowed, flagged, and Lou is told.
    sent.length = 0;
    const same = await signIn(key, { counter: 3 });
    expect(same.response.status).toBe(200);
    const flagged = await coreQuery<{ flag: string | null }>("select flag from sign_in_events where user_id = $1 order by sign_in_events.id desc limit 1", [lou.id]);
    expect(flagged.rows[0].flag).toMatch(/didn't count up \(3 after 3\)/);
    expect(sent.some((email) => email.to === "lou@example.com" && email.subject === "Tohyee: a sign-in to check")).toBe(true);

    // Lower than before (and not 0): a copied key. Refused, recorded and emailed.
    sent.length = 0;
    const copied = await signIn(key, { counter: 2 });
    expect(copied.response.status).toBe(403);
    expect(copied.session).toBe("");
    const last = await coreQuery<{ outcome: string; flag: string }>("select outcome, flag from sign_in_events where user_id = $1 order by sign_in_events.id desc limit 1", [lou.id]);
    expect(last.rows[0]).toMatchObject({ outcome: "refused" });
    expect(last.rows[0].flag).toMatch(/may have been copied/);
    expect(sent.some((email) => email.to === "lou@example.com" && email.subject === "Tohyee: a passkey sign-in was refused")).toBe(true);
    // The count isn't moved back.
    expect((await coreQuery<{ n: string }>("select sign_count::text as n from user_passkeys where user_id = $1", [lou.id])).rows[0].n).toBe("3");
    // Counting on again works.
    expect((await signIn(key, { counter: 4 })).response.status).toBe(200);
  });

  it("refuses adding or using passkeys on a home-network address, and says why", async () => {
    const mia = await createTestUser("mia@example.com");
    const cookie = await sessionCookieFor(mia);
    for (const host of ["192.168.1.20:3000", "farm-pc:3000", "tohyee.local"]) {
      const started = await optionsRoute.POST(
        apiRequest("/api/auth/passkeys/options", { method: "POST", cookie, body: { password: TEST_PASSWORD }, headers: { host }, origin: `http://${host}` }),
        noContext,
      );
      expect(started.status).toBe(400);
      expect((await body(started)).error).toMatch(/Passkeys don't work on a(n address made of numbers| home-network name).*https:\/\/books\.example\.nz/);
      const signInStart = await signInOptionsRoute.POST(apiRequest("/api/auth/passkeys/sign-in/options", { method: "POST", headers: { host }, origin: `http://${host}` }), noContext);
      expect(signInStart.status).toBe(400);
    }
    // localhost on the server computer works, with its own passkeys.
    const local = await optionsRoute.POST(apiRequest("/api/auth/passkeys/options", { method: "POST", cookie, body: { password: TEST_PASSWORD }, headers: { host: "localhost:3000" }, origin: "http://localhost:3000" }), noContext);
    expect(local.status).toBe(200);
    expect(((await body(local)).options as { rp: { id: string } }).rp.id).toBe("localhost");
    const status = await body(await passkeysRoute.GET(apiRequest("/api/auth/passkeys", { cookie, headers: { host: "192.168.1.20:3000" } }), noContext));
    expect((status.passkeys as Json).rpId).toBeNull();
    expect((status.passkeys as Json).problem).toMatch(/192\.168\.1\.20/);
  });

  it("ties adding to the session that started it, and lets you rename and remove your own", async () => {
    const pat = await createTestUser("pat@example.com");
    const cookie = await sessionCookieFor(pat);
    const otherSession = await sessionCookieFor(pat);
    const phone = new SoftAuthenticator();
    const started = await startAdding(cookie);
    // Finished in another session of the same login: refused.
    expect((await finishAdding(otherSession, phone.create(started.options!, ORIGIN))).status).toBe(400);

    const first = await addPasskey(cookie, phone, "Pat's phone");
    const laptop = new SoftAuthenticator();
    const second = await addPasskey(cookie, laptop, "Pat's laptop");
    // The same passkey can't be added twice: the browser is told which ones exist.
    const again = await startAdding(cookie);
    expect((again.options!.excludeCredentials as { id: string }[]).map((entry) => entry.id).sort()).toEqual([phone.passkeys.at(-1)!.id, laptop.passkeys[0].id].sort());

    const renamed = await passkeyRoute.PATCH(req(`/api/auth/passkeys/${first.id}`, { method: "PATCH", cookie, body: { name: "Pat's iPhone 15" } }), params({ passkeyId: first.id }));
    expect(renamed.status).toBe(200);
    expect((await body(renamed)).passkey).toMatchObject({ name: "Pat's iPhone 15" });
    expect((await passkeyRoute.PATCH(req(`/api/auth/passkeys/${first.id}`, { method: "PATCH", cookie, body: { name: "x".repeat(61) } }), params({ passkeyId: first.id }))).status).toBe(400);
    // Someone else's passkey can't be renamed or removed.
    const other = await sessionCookieFor(await createTestUser("other@example.com"));
    expect((await passkeyRoute.PATCH(req(`/api/auth/passkeys/${first.id}`, { method: "PATCH", cookie: other, body: { name: "Mine" } }), params({ passkeyId: first.id }))).status).toBe(404);
    expect((await passkeyRoute.DELETE(req(`/api/auth/passkeys/${first.id}`, { method: "DELETE", cookie: other }), params({ passkeyId: first.id }))).status).toBe(404);

    // Removing a passkey ends the sessions it signed in, but not the one doing the removing.
    const viaPhone = (await signIn(phone)).session;
    const viaPhoneToo = (await signIn(phone)).session;
    const viaLaptop = (await signIn(laptop)).session;
    sent.length = 0;
    const removed = await passkeyRoute.DELETE(req(`/api/auth/passkeys/${first.id}`, { method: "DELETE", cookie: viaPhone }), params({ passkeyId: first.id }));
    expect(removed.status).toBe(200);
    expect(await signedIn(viaPhone)).toBe(true);
    expect(await signedIn(viaPhoneToo)).toBe(false);
    expect(await signedIn(viaLaptop)).toBe(true);
    expect(sent.map((email) => email.subject)).toContain("Tohyee: a passkey was removed");
    expect((await signIn(phone)).response.status).toBe(401);
    const list = await body(await passkeysRoute.GET(req("/api/auth/passkeys", { cookie }), noContext));
    expect(((list.passkeys as Json).passkeys as { id: string }[]).map((entry) => entry.id)).toEqual([second.id]);
  });

  it("someone who signs in with Google only adds one within 5 minutes of signing in", async () => {
    const gil = await createTestUser("gil@example.com");
    await coreQuery("update users set google_only = true where id = $1", [gil.id]);
    const stale = await withCoreTransaction(async (client) => {
      const made = await createSession(client, gil.id, { userAgent: "vitest", ipAddress: null }, { method: "google" });
      await client.query("update sessions set created_at = now() - interval '6 minutes' where user_id = $1", [gil.id]);
      return `tohyee_session=${made.token}`;
    });
    const refused = await startAdding(stale, undefined);
    expect(refused.response.status).toBe(403);
    expect((await body(refused.response)).error).toMatch(/sign in with Google again/);
    const fresh = await withCoreTransaction(async (client) => `tohyee_session=${(await createSession(client, gil.id, { userAgent: "vitest", ipAddress: null }, { method: "google" })).token}`);
    const status = await body(await passkeysRoute.GET(req("/api/auth/passkeys", { cookie: fresh }), noContext));
    expect((status.passkeys as Json).needsPassword).toBe(false);
    expect((status.passkeys as Json).freshUntil).not.toBeNull();
    const started = await startAdding(fresh, undefined);
    expect(started.response.status).toBe(200);
  });

  it("a server admin removes someone's passkeys: their passkey sessions end and their apps disconnect", async () => {
    const ORG = "passkey-books";
    await createTestOrganisation(admin, ORG);
    const rua = await createTestUser("rua@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, rua.id]);
    const passwordSession = await sessionCookieFor(rua);
    const phone = new SoftAuthenticator();
    await addPasskey(passwordSession, phone, "Rua's phone");
    const viaPasskey = (await signIn(phone)).session;
    const farm = await createFarmAppKey({ sessionId: "made-up", user: rua }, ORG, { name: "Paddock app", scopes: ["read_farm"], role: "bookkeeper" });
    expect(await authenticateFarmAppKey(farm.key)).not.toBeNull();

    // Only a server admin, on the server computer.
    const ruaCookie = await sessionCookieFor(rua);
    expect((await adminUserPasskeysRoute.DELETE(apiRequest(`/api/admin/users/${rua.id}/passkeys`, { method: "DELETE", cookie: ruaCookie }), params({ userId: rua.id }))).status).toBe(403);
    expect((await adminUserPasskeysRoute.DELETE(apiRequest(`/api/admin/users/${rua.id}/passkeys`, { method: "DELETE", cookie: adminCookie, local: false }), params({ userId: rua.id }))).status).toBe(403);

    sent.length = 0;
    const removed = await adminUserPasskeysRoute.DELETE(apiRequest(`/api/admin/users/${rua.id}/passkeys`, { method: "DELETE", cookie: adminCookie }), params({ userId: rua.id }));
    expect(removed.status).toBe(200);
    expect(await body(removed)).toEqual({ removed: 1 });
    expect(await signedIn(viaPasskey)).toBe(false);
    expect(await signedIn(passwordSession)).toBe(true);
    expect(await authenticateFarmAppKey(farm.key)).toBeNull();
    expect((await signIn(phone)).response.status).toBe(401);
    expect(sent.find((email) => email.to === "rua@example.com")?.subject).toBe("Tohyee: your passkeys were removed");
    const audit = await coreQuery<{ details: Json }>("select details from admin_audit_events where event_type = 'user.passkeys_removed' and entity_id = $1", [rua.id]);
    expect(audit.rows[0].details).toMatchObject({ removed: 1, aiKeysRevoked: 1 });
    // Nothing left to remove.
    expect((await adminUserPasskeysRoute.DELETE(apiRequest(`/api/admin/users/${rua.id}/passkeys`, { method: "DELETE", cookie: adminCookie }), params({ userId: rua.id }))).status).toBe(409);
  });

  it("a password or two-step reset, a login turned off, or changing your password ends passkeys", async () => {
    const count = async (id: string) => Number((await coreQuery<{ n: string }>("select count(*)::text as n from user_passkeys where user_id = $1", [id])).rows[0].n);

    const resetMe = await createTestUser("reset@example.com");
    await addPasskey(await sessionCookieFor(resetMe), new SoftAuthenticator());
    const reset = await adminUserRoute.PATCH(apiRequest(`/api/admin/users/${resetMe.id}`, { method: "PATCH", cookie: adminCookie, body: { newPassword: "a-brand-new-password" } }), params({ userId: resetMe.id }));
    expect(reset.status).toBe(200);
    expect(await count(resetMe.id)).toBe(0);

    const offMe = await createTestUser("off@example.com");
    const offPhone = new SoftAuthenticator();
    await addPasskey(await sessionCookieFor(offMe), offPhone);
    expect((await adminUserRoute.PATCH(apiRequest(`/api/admin/users/${offMe.id}`, { method: "PATCH", cookie: adminCookie, body: { isActive: false } }), params({ userId: offMe.id }))).status).toBe(200);
    expect(await count(offMe.id)).toBe(0);
    expect((await signIn(offPhone)).response.status).toBe(401);

    const twoStepMe = await createTestUser("twostep@example.com");
    await addPasskey(await sessionCookieFor(twoStepMe), new SoftAuthenticator());
    expect((await adminTwoStepRoute.DELETE(apiRequest(`/api/admin/users/${twoStepMe.id}/two-step`, { method: "DELETE", cookie: adminCookie }), params({ userId: twoStepMe.id }))).status).toBe(200);
    expect(await count(twoStepMe.id)).toBe(0);

    // Changing your own password: passkeys end, but this session (signed in with one) stays.
    const own = await createTestUser("own@example.com");
    const ownPhone = new SoftAuthenticator();
    await addPasskey(await sessionCookieFor(own), ownPhone);
    const viaPasskey = (await signIn(ownPhone)).session;
    const changed = await passwordRoute.POST(req("/api/auth/password", { method: "POST", cookie: viaPasskey, body: { currentPassword: TEST_PASSWORD, newPassword: "another-new-password" } }), noContext);
    expect(changed.status).toBe(200);
    expect(await count(own.id)).toBe(0);
    expect(await signedIn(viaPasskey)).toBe(true);
  });

  it("is limited per address like other sign-ins, and paused remote access refuses it", async () => {
    const from = { "x-forwarded-for": "203.0.113.77" };
    let last = 0;
    for (let index = 0; index < 31; index += 1) {
      last = (await signInOptionsRoute.POST(req("/api/auth/passkeys/sign-in/options", { method: "POST", headers: from }), noContext)).status;
      if (last !== 200) break;
    }
    expect(last).toBe(429);
    expect((await signInRoute.POST(req("/api/auth/passkeys/sign-in", { method: "POST", headers: from, body: { response: {} } }), noContext)).status).toBe(429);

    await withCoreTransaction((client) => writeServerValue(client, "remote_pause", { until: new Date(Date.now() + 60 * 60 * 1000).toISOString(), pausedAt: new Date().toISOString(), failures: 20, trips: [] }, "test"));
    forgetRemotePauseCache();
    try {
      expect((await signInOptionsRoute.POST(req("/api/auth/passkeys/sign-in/options", { method: "POST" }), noContext)).status).toBe(403);
      expect((await signInRoute.POST(req("/api/auth/passkeys/sign-in", { method: "POST", body: { response: {} } }), noContext)).status).toBe(403);
    } finally {
      await resumeRemoteAccess({ userId: null, email: "test" });
      forgetRemotePauseCache();
    }
  });
});
