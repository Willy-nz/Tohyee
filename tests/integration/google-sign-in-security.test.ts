import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import * as adminGoogleRoute from "@/app/api/admin/google-sign-in/route";
import * as adminUserGoogleRoute from "@/app/api/admin/users/[userId]/google/route";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as unlinkRoute from "@/app/api/auth/google/unlink/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as sessionRoute from "@/app/api/auth/session/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as registerRoute from "@/app/api/oauth/register/route";
import * as consentRoute from "@/app/api/oauth/requests/[handle]/route";
import * as tokenRoute from "@/app/api/oauth/token/route";
import * as authorizeRoute from "@/app/oauth/authorize/route";
import { OAUTH_BROWSER_COOKIE } from "@/lib/ai/oauth/authorize";
import { authenticateOfficeToken } from "@/lib/ai/oauth/tokens";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import type { SessionUser } from "@/lib/auth/sessions";
import { recoverPeople } from "@/lib/backups/recovery";
import { backUpNow, listBackupFiles, updateBackupSettings } from "@/lib/backups/service";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { type OutgoingEmail, setEmailSenderForTests, updateEmailSettings } from "@/lib/email/mailer";
import { authenticateFarmAppKey, createFarmAppKey } from "@/lib/farm-apps/keys";
import { MailOwner } from "@/lib/private-mail/access";
import { newWrappedDataKey } from "@/lib/private-mail/crypto";
import { myMail } from "@/lib/private-mail/store";
import { writeServerValue } from "@/lib/server-settings";
import { body, CLIENT, fakeGoogle, noContext, req, SECRET, viaGoogle } from "../helpers/fake-google";
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

/*
 * Sign in with Google and what can act as a person (#432, decisions
 * 850-854): a server admin removing someone's Google sign-in ends every app
 * and key that acts as them, but not their password; recovering people from
 * a server backup brings their Google link back without losing it to the
 * account it replaces. Google, the AI app and the people are all made up.
 */

const PUBLIC = "https://books.example.nz";
const MCP_RESOURCE = `${PUBLIC}/api/mcp`;
const OFFICE_RESOURCE = `${PUBLIC}/api/office`;
const OFFICE_CLIENT = `${PUBLIC}/office/powerpoint/client.json`;
const OFFICE_REDIRECT = `${PUBLIC}/office/powerpoint/signed-in`;
const AI_CALLBACK = "https://ai.example.com/oauth/callback";

type Json = Record<string, unknown>;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function token(values: Record<string, string>) {
  const response = await tokenRoute.POST(
    new Request(`${PUBLIC}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values).toString() }),
    noContext,
  );
  return { status: response.status, body: (await response.json()) as Json };
}

async function mcp(bearer: string, method = "tools/list") {
  const response = await mcpRoute.POST(
    new Request(MCP_RESOURCE, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }) }),
    noContext,
  );
  return response.status;
}

/** The browser part of an app signing in: authorise, then allow on the consent screen. Returns the code the app gets back. */
async function allow(cookie: string, app: { clientId: string; redirectUri: string; resource: string }, choice: Json) {
  const { verifier, challenge } = pkce();
  const url = new URL("http://tohyee.test/oauth/authorize");
  for (const [name, value] of Object.entries({ response_type: "code", client_id: app.clientId, redirect_uri: app.redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "s-1", resource: app.resource })) {
    url.searchParams.set(name, value);
  }
  const started = await authorizeRoute.GET(new Request(url), noContext);
  expect(started.status).toBe(303);
  const handle = /\/connect\/([A-Za-z0-9_-]{43})$/.exec(started.headers.get("location") ?? "")![1];
  const browser = /tohyee_oauth_browser=([^;]+)/.exec(started.headers.get("set-cookie") ?? "")![1];
  const decided = await consentRoute.POST(
    apiRequest(`/api/oauth/requests/${handle}`, { method: "POST", cookie: `${cookie}; ${OAUTH_BROWSER_COOKIE}=${browser}`, body: choice }),
    params({ handle }),
  );
  expect(decided.status).toBe(200);
  const back = new URL(((await decided.json()) as Json).redirectTo as string);
  return { code: back.searchParams.get("code")!, verifier, ...app };
}

async function exchange(flow: Awaited<ReturnType<typeof allow>>) {
  return token({ grant_type: "authorization_code", code: flow.code, client_id: flow.clientId, redirect_uri: flow.redirectUri, code_verifier: flow.verifier, resource: flow.resource });
}

async function withGoogleApp(adminCookie: string) {
  const saved = await adminGoogleRoute.PUT(req("/api/admin/google-sign-in", { method: "PUT", body: { enabled: true, clientId: CLIENT, clientSecret: SECRET }, cookie: adminCookie, local: true }), noContext);
  expect(saved.status).toBe(200);
}

describeWithDatabase("a server admin removing Google sign-in ends what acts as the person (#432, decision 850)", () => {
  let server: TestServer;
  const originalKey = process.env.TOHYEE_SECRET_KEY;
  const sent: OutgoingEmail[] = [];
  let admin: SessionUser;
  let adminCookie = "";
  let aiClientId = "";
  const ORG = "google-apps-books";

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "google-security-test-key-0123456789abcdef";
    server = await startTestServer();
    setMailFetchForTests(fakeGoogle);
    setEmailSenderForTests(async (message) => {
      sent.push(message);
    });
    admin = await createTestUser("admin@example.com", { serverAdmin: true, displayName: "Admin" });
    adminCookie = await sessionCookieFor(admin);
    await updateEmailSettings({ user: { id: admin.id, email: admin.email, isServerAdmin: true } }, { host: "smtp.gmail.com", port: 465, username: "books@example.com", password: "app-password" });
    await withGoogleApp(adminCookie);
    await createTestOrganisation(admin, ORG);
    await withCoreTransaction((client) => writeServerValue(client, "remote_access", { enabled: true, publicUrl: PUBLIC }, "test"));
    const registered = await registerRoute.POST(
      new Request("http://tohyee.test/api/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Made-up AI", redirect_uris: [AI_CALLBACK], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
      }),
      noContext,
    );
    aiClientId = ((await registered.json()) as Json).client_id as string;
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

  const aiApp = () => ({ clientId: aiClientId, redirectUri: AI_CALLBACK, resource: MCP_RESOURCE });
  const officeApp = { clientId: OFFICE_CLIENT, redirectUri: OFFICE_REDIRECT, resource: OFFICE_RESOURCE };

  it("stops AI apps (with refresh tokens), codes not yet swapped, AI keys, the PowerPoint add-in and farm app keys; the password still works", async () => {
    const lee = await createTestUser("lee@example.com", { displayName: "Lee" });
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, lee.id]);
    const passwordSession = await sessionCookieFor(lee);
    const google = { sub: "sub-lee", email: "lee.personal@example.com" };
    expect((await viaGoogle({ purpose: "link", password: TEST_PASSWORD }, google, passwordSession)).location).toMatch(/google=linked$/);

    // Signed in through Google, Lee (or whoever has the Google account) connects apps and makes keys.
    const googleSession = (await viaGoogle({ purpose: "sign_in" }, google)).session;
    expect(googleSession).not.toBe("");
    const ai = await exchange(await allow(googleSession, aiApp(), { decision: "allow", organisationId: ORG, accessLevel: "read" }));
    expect(ai.status).toBe(200);
    const aiAccess = ai.body.access_token as string;
    const aiRefresh = ai.body.refresh_token as string;
    expect(await mcp(aiAccess)).toBe(200);
    const pendingAi = await allow(googleSession, aiApp(), { decision: "allow", organisationId: ORG, accessLevel: "read" });
    const office = await exchange(await allow(googleSession, officeApp, { decision: "allow" }));
    expect(office.status).toBe(200);
    expect(await authenticateOfficeToken(office.body.access_token as string)).not.toBeNull();
    const pendingOffice = await allow(googleSession, officeApp, { decision: "allow" });
    const madeKey = await tokensRoute.POST(apiRequest("/api/ai/tokens", { method: "POST", cookie: googleSession, body: { organisationId: ORG, name: "Desktop" } }), noContext);
    expect(madeKey.status).toBe(201);
    const aiKey = ((await madeKey.json()) as Json).token as string;
    expect(await mcp(aiKey, "ping")).toBe(200);
    const farm = await createFarmAppKey({ sessionId: "made-up", user: lee }, ORG, { name: "Paddock app", scopes: ["read_farm"], role: "bookkeeper" });
    expect(await authenticateFarmAppKey(farm.key)).not.toBeNull();

    // The server admin removes Google sign-in.
    const removed = await adminUserGoogleRoute.DELETE(req(`/api/admin/users/${lee.id}/google`, { method: "DELETE", cookie: adminCookie }), params({ userId: lee.id }));
    expect(removed.status).toBe(200);
    expect(await body(removed)).toEqual({ googleOnly: false });

    // Nothing made through the Google account acts as Lee any more.
    expect(await mcp(aiAccess)).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: aiRefresh, client_id: aiClientId, resource: MCP_RESOURCE })).body.error).toBe("invalid_grant");
    expect((await exchange(pendingAi)).body.error).toBe("invalid_grant");
    expect(await authenticateOfficeToken(office.body.access_token as string)).toBeNull();
    expect((await token({ grant_type: "refresh_token", refresh_token: office.body.refresh_token as string, client_id: OFFICE_CLIENT, resource: OFFICE_RESOURCE })).body.error).toBe("invalid_grant");
    expect((await exchange(pendingOffice)).body.error).toBe("invalid_grant");
    expect(await mcp(aiKey, "ping")).toBe(401);
    expect(await authenticateFarmAppKey(farm.key)).toBeNull();
    expect((await sessionRoute.GET(req("/api/auth/session", { cookie: googleSession }), noContext)).status).toBe(401);
    expect((await coreQuery("select count(*)::int as n from ai_access_tokens where user_id = $1 and revoked_at is null", [lee.id])).rows[0]).toEqual({ n: 0 });
    const audit = await coreQuery<{ details: Json }>("select details from admin_audit_events where event_type = 'user.google_removed' and entity_id = $1", [lee.id]);
    expect(audit.rows[0].details).toMatchObject({ googleEmail: google.email, aiKeysRevoked: 4 });
    const alert = sent.find((email) => email.to === "lee@example.com" && email.subject === "Tohyee: Google sign-in was removed");
    expect(alert?.text).toMatch(/AI apps, AI keys, farm app keys and PowerPoint add-in sign-ins were disconnected/);
    expect(alert?.text).toMatch(/You can still sign in with your password/);

    // The password still works: this session, a new sign-in, and connecting an app again.
    expect((await sessionRoute.GET(req("/api/auth/session", { cookie: passwordSession }), noContext)).status).toBe(200);
    expect((await loginRoute.POST(req("/api/auth/login", { method: "POST", body: { email: "lee@example.com", password: TEST_PASSWORD } }), noContext)).status).toBe(200);
    const again = await exchange(await allow(passwordSession, aiApp(), { decision: "allow", organisationId: ORG, accessLevel: "read" }));
    expect(again.status).toBe(200);
    expect(await mcp(again.body.access_token as string)).toBe(200);
  });

  it("unlinking your own Google account keeps your apps, and the email says how to disconnect them (decision 852)", async () => {
    const mo = await createTestUser("mo@example.com", { displayName: "Mo" });
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, mo.id]);
    const cookie = await sessionCookieFor(mo);
    expect((await viaGoogle({ purpose: "link", password: TEST_PASSWORD }, { sub: "sub-mo", email: "mo.personal@example.com" }, cookie)).location).toMatch(/google=linked$/);
    const ai = await exchange(await allow(cookie, aiApp(), { decision: "allow", organisationId: ORG, accessLevel: "read" }));
    expect(ai.status).toBe(200);

    expect((await unlinkRoute.POST(req("/api/auth/google/unlink", { method: "POST", cookie }), noContext)).status).toBe(200);
    expect(await mcp(ai.body.access_token as string)).toBe(200);
    const alert = sent.find((email) => email.to === "mo@example.com" && email.subject === "Tohyee: Google sign-in was unlinked");
    expect(alert?.text).toMatch(/keep working/);
    expect(alert?.text).toMatch(/change your password: that disconnects them all/);
  });
});

/** What the person sees of private mail in an organisation, through the one access layer; "not found" counts as nothing. */
async function privateCopiesSeenBy(organisationId: string, user: { id: string; email: string }): Promise<number> {
  return inOrganisation(organisationId, { userId: user.id, email: user.email }, async (tx) => {
    try {
      const owner = await MailOwner.of(tx);
      const mail = await myMail(tx, owner);
      return mail.detached.length + mail.mailboxes.filter((m) => m.copy).length;
    } catch {
      return 0;
    }
  });
}

describeWithDatabase("recovering people keeps their Google sign-in (#432, decision 851)", () => {
  let server: TestServer;
  const originalKey = process.env.TOHYEE_SECRET_KEY;
  let folder = "";
  let serverFile = "";
  let admin: SessionUser;
  let adminCookie = "";
  const original: Record<string, string> = {};

  async function googleOf(userId: string) {
    return (await coreQuery<{ google_sub: string; email: string }>("select google_sub, email from user_google_identities where user_id = $1", [userId])).rows[0] ?? null;
  }

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "google-recovery-test-key-0123456789abcdef";
    server = await startTestServer();
    setMailFetchForTests(fakeGoogle);
    setEmailSenderForTests(async () => {});
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-google-recovery-"));
    admin = await createTestUser("admin@example.com", { serverAdmin: true });
    adminCookie = await sessionCookieFor(admin);
    await withGoogleApp(adminCookie);
    await createTestOrganisation(admin, "rec-farm");

    // On the first server: Kim (Google only, with private mail), Pat (password and Google),
    // Sam (password only) and Ria (Google only).
    const unusable = await hashPassword(randomBytes(24).toString("base64url"));
    for (const [name, sub, googleOnly] of [["kim", "sub-kim", true], ["pat", "sub-pat", false], ["sam", null, false], ["ria", "sub-ria", true]] as const) {
      const person = await createTestUser(`${name}@example.com`, { twoStep: false });
      original[name] = person.id;
      if (googleOnly) await coreQuery("update users set google_only = true, password_hash = $2 where id = $1", [person.id, unusable]);
      if (sub) await coreQuery("insert into user_google_identities (user_id, google_sub, email) values ($1, $2, $3)", [person.id, sub, `${name}.google@example.com`]);
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ('rec-farm', $1, $2)", [person.id, name === "kim" ? "owner" : "viewer"]);
    }
    await inOrganisation("rec-farm", { userId: original.kim, email: "kim@example.com" }, (tx) =>
      tx.query("insert into private_mail_copies (owner_user_id, provider, mailbox_email, data_key_ciphertext) values ($1, 'google', 'kim@example.com', $2)", [original.kim, newWrappedDataKey()]),
    );
    await updateBackupSettings({ user: admin }, { folder });
    await backUpNow({ trigger: "manual", requestedByEmail: admin.email });
    serverFile = (await listBackupFiles()).find((f) => f.header?.kind === "server")!.path;

    // Then the logins are lost and made again here under new IDs, as on a replacement server:
    // Kim links the same Google account, Sam links one for the first time, and Ria's Google
    // account ends up linked to someone else's login.
    await coreQuery("delete from users where id = any($1::uuid[])", [[original.kim, original.pat, original.sam, original.ria]]);
    await createTestOrganisation(admin, "new-co");
    const kimHere = await createTestUser("kim@example.com", { twoStep: false });
    await coreQuery("update users set google_only = true, password_hash = $2 where id = $1", [kimHere.id, unusable]);
    await coreQuery("insert into user_google_identities (user_id, google_sub, email) values ($1, 'sub-kim', 'kim.google@example.com')", [kimHere.id]);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ('new-co', $1, 'bookkeeper')", [kimHere.id]);
    await createTestUser("pat@example.com", { twoStep: false });
    const samHere = await createTestUser("sam@example.com", { twoStep: false });
    await coreQuery("insert into user_google_identities (user_id, google_sub, email) values ($1, 'sub-sam', 'sam.google@example.com')", [samHere.id]);
    const other = await createTestUser("other@example.com", { twoStep: false });
    await coreQuery("insert into user_google_identities (user_id, google_sub, email) values ($1, 'sub-ria', 'ria.google@example.com')", [other.id]);
    original.other = other.id;
  }, 600_000);

  afterAll(async () => {
    setMailFetchForTests(null);
    setEmailSenderForTests(null);
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
    await fs.rm(folder, { recursive: true, force: true });
  });

  it("puts each Google link back on the original ID, reports one linked to another login, and doesn't change on a second run", async () => {
    const replace = ["kim@example.com", "pat@example.com", "sam@example.com"];
    const preview = await recoverPeople({ user: admin }, { file: serverFile, replace });
    expect(preview.applied).toBe(false);
    expect(preview.googleNotRestored).toEqual([{ email: "ria@example.com", googleEmail: "ria.google@example.com", linkedTo: "other@example.com", needsSetupLink: true }]);
    expect(preview.googleMoved).toEqual(["sam@example.com"]);

    const plan = await recoverPeople({ user: admin }, { file: serverFile, replace, apply: true });
    expect(plan.applied).toBe(true);
    expect(plan.googleNotRestored).toEqual(preview.googleNotRestored);
    expect(plan.googleMoved).toEqual(["sam@example.com"]);

    const users = await coreQuery<{ email: string; id: string; google_only: boolean }>("select email, id::text, google_only from users where email <> 'admin@example.com' order by email");
    expect(users.rows).toEqual([
      { email: "kim@example.com", id: original.kim, google_only: true },
      { email: "other@example.com", id: original.other, google_only: false },
      { email: "pat@example.com", id: original.pat, google_only: false },
      { email: "ria@example.com", id: original.ria, google_only: false }, // her Google link isn't back, so not Google only
      { email: "sam@example.com", id: original.sam, google_only: false },
    ]);
    // The same Google account as the replaced login: kept, on the original ID.
    expect(await googleOf(original.kim)).toEqual({ google_sub: "sub-kim", email: "kim.google@example.com" });
    expect(await googleOf(original.pat)).toEqual({ google_sub: "sub-pat", email: "pat.google@example.com" });
    // The backup had none for Sam: the one made here comes with them.
    expect(await googleOf(original.sam)).toEqual({ google_sub: "sub-sam", email: "sam.google@example.com" });
    // Ria's Google account stays with the other login.
    expect(await googleOf(original.ria)).toBeNull();
    expect(await googleOf(original.other)).toEqual({ google_sub: "sub-ria", email: "ria.google@example.com" });
    expect((await coreQuery("select count(*)::int as n from users where email like 'replaced-%'")).rows[0]).toEqual({ n: 0 });

    // Google sign-in works for Kim and Pat, as their original logins; Pat's password still works too.
    for (const [name, sub] of [["kim", "sub-kim"], ["pat", "sub-pat"]] as const) {
      const signedIn = await viaGoogle({ purpose: "sign_in" }, { sub, email: `${name}.google@example.com` });
      expect(signedIn.session).not.toBe("");
      const session = (await body(await sessionRoute.GET(req("/api/auth/session", { cookie: signedIn.session }), noContext))) as { user: { id: string } };
      expect(session.user.id).toBe(original[name]);
    }
    const pat = (await coreQuery<{ password_hash: string }>("select password_hash from users where id = $1", [original.pat])).rows[0];
    expect(await verifyPassword(TEST_PASSWORD, pat.password_hash)).toBe(true);

    // Memberships and private mail are the original IDs': the backup's, and the one Kim's replaced login had here.
    const members = await coreQuery<{ organisation_id: string; user_id: string; role: string }>(
      "select organisation_id, user_id::text, role from organisation_members where user_id = any($1::uuid[]) order by organisation_id, user_id",
      [[original.kim, original.pat, original.sam, original.ria]],
    );
    expect(members.rows).toEqual(
      [
        { organisation_id: "new-co", user_id: original.kim, role: "bookkeeper" },
        ...["kim", "pat", "sam", "ria"].map((name) => ({ organisation_id: "rec-farm", user_id: original[name], role: name === "kim" ? "owner" : "viewer" })),
      ].sort((a, b) => a.organisation_id.localeCompare(b.organisation_id) || a.user_id.localeCompare(b.user_id)),
    );
    expect(await privateCopiesSeenBy("rec-farm", { id: original.kim, email: "kim@example.com" })).toBe(1);
    expect(await privateCopiesSeenBy("rec-farm", { id: admin.id, email: admin.email })).toBe(0);

    // A second run changes nothing.
    const again = await recoverPeople({ user: admin }, { file: serverFile, apply: true });
    expect(again.add).toEqual([]);
    expect(again.googleNotRestored).toEqual([]);
    expect(again.googleMoved).toEqual([]);
    expect(await googleOf(original.kim)).toEqual({ google_sub: "sub-kim", email: "kim.google@example.com" });
    expect(await googleOf(original.other)).toEqual({ google_sub: "sub-ria", email: "ria.google@example.com" });
  }, 600_000);
});
