import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import * as setupAccountRoute from "@/app/api/auth/setup-account/route";
import * as invitationRoute from "@/app/api/organisations/[organisationId]/members/[userId]/invitation/route";
import * as memberRoute from "@/app/api/organisations/[organisationId]/members/[userId]/route";
import * as membersRoute from "@/app/api/organisations/[organisationId]/members/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import { type OutgoingEmail, setEmailSenderForTests, updateEmailSettings } from "@/lib/email/mailer";
import { farmScope } from "@/lib/farming/access";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { INVITES_PER_HOUR, type Member } from "@/lib/organisations/members";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "invite-org";
const OTHER = "invite-other";

type Json = Record<string, unknown>;
const json = async (response: Response) => (await response.json()) as Json;

/**
 * Inviting people from People and roles (#441, decisions 870-879), as Xero
 * does. Email is captured, never sent; every person and address is made up.
 */
describeWithDatabase("inviting people from People and roles (#441)", () => {
  let server: TestServer;
  const originalKey = process.env.TOHYEE_SECRET_KEY;
  const sent: OutgoingEmail[] = [];
  let emailWorks = true;
  let owner: SessionUser;
  let admin: SessionUser;
  let bookkeeper: SessionUser;
  let existing: SessionUser;
  const cookies = new Map<string, string>();
  const cookie = async (user: SessionUser) => {
    if (!cookies.has(user.id)) cookies.set(user.id, await sessionCookieFor(user));
    return cookies.get(user.id)!;
  };

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "member-invitations-test-key-0123456789abcdef";
    server = await startTestServer();
    setEmailSenderForTests(async (message) => {
      if (!emailWorks) throw new Error("mail server unreachable");
      sent.push(message);
    });
    owner = await createTestUser("inv-owner@example.com", { serverAdmin: true, displayName: "Aroha Owner" });
    admin = await createTestUser("inv-admin@example.com", { displayName: "Rangi Admin" });
    bookkeeper = await createTestUser("inv-bookkeeper@example.com", { displayName: "Mere Bookkeeper" });
    existing = await createTestUser("inv-existing@example.com", { displayName: "Tama Existing" });
    await updateEmailSettings({ user: { id: owner.id, email: owner.email, isServerAdmin: true } }, { host: "smtp.example.com", port: 465, username: "books@example.com", password: "app-password" });
    await createTestOrganisation(owner, ORG);
    await createTestOrganisation(owner, OTHER);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'bookkeeper')", [ORG, admin.id, bookkeeper.id]);
  });

  beforeEach(() => {
    sent.length = 0;
    emailWorks = true;
  });

  afterAll(async () => {
    setEmailSenderForTests(null);
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
  });

  const invite = async (as: SessionUser, body: Json, organisationId = ORG) =>
    membersRoute.POST(apiRequest(`/api/organisations/${organisationId}/members`, { method: "POST", cookie: await cookie(as), body }), params({ organisationId }));
  const resend = async (as: SessionUser, userId: string, organisationId = ORG) =>
    invitationRoute.POST(apiRequest(`/api/organisations/${organisationId}/members/${userId}/invitation`, { method: "POST", cookie: await cookie(as) }), params({ organisationId, userId }));
  const cancel = async (as: SessionUser, userId: string, organisationId = ORG) =>
    invitationRoute.DELETE(apiRequest(`/api/organisations/${organisationId}/members/${userId}/invitation`, { method: "DELETE", cookie: await cookie(as) }), params({ organisationId, userId }));
  const members = async (organisationId = ORG) =>
    ((await json(await membersRoute.GET(apiRequest(`/api/organisations/${organisationId}/members`, { cookie: await cookie(owner) }), params({ organisationId })))).members as Member[]);
  const memberFor = async (email: string, organisationId = ORG) => (await members(organisationId)).find((member) => member.email === email);
  const tokenIn = (text: string) => decodeURIComponent(/token=([^\s]+)/.exec(text)![1]);
  const loginFor = async (email: string) =>
    (await coreQuery<{ id: string; is_server_admin: boolean; is_active: boolean; memberships: number }>(
      "select u.id, u.is_server_admin, u.is_active, (select count(*) from organisation_members m where m.user_id = u.id)::int as memberships from users u where u.email = $1",
      [email],
    )).rows[0];
  const auditFor = async (eventType: string, entityId: string) =>
    (await coreQuery<{ actor_email: string; details: Json }>("select actor_email, details from admin_audit_events where event_type = $1 and entity_id = $2 order by id desc limit 1", [eventType, entityId])).rows[0];

  it("makes a login for someone new, only for this organisation, and emails them a setup link", async () => {
    const response = await invite(admin, { email: "Kiri.New@Example.com", displayName: "Kiri New", role: "viewer" });
    expect(response.status).toBe(201);
    const result = await json(response);
    expect(result.invited).toBe(true);
    expect(result.invitation).toMatchObject({ emailed: true, url: null });
    expect(result.member).toMatchObject({ email: "kiri.new@example.com", displayName: "Kiri New", role: "viewer", invited: true });

    const login = await loginFor("kiri.new@example.com");
    expect(login).toMatchObject({ is_server_admin: false, is_active: true, memberships: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("kiri.new@example.com");
    expect(sent[0].subject).toBe(`Tohyee: you're invited to Test ${ORG}`);
    expect(sent[0].text).toContain("Rangi Admin (inv-admin@example.com) has invited you");
    const state = await json(await setupAccountRoute.GET(apiRequest(`/api/auth/setup-account?token=${encodeURIComponent(tokenIn(sent[0].text))}`), undefined as never));
    expect(state).toMatchObject({ valid: true, email: "kiri.new@example.com", displayName: "Kiri New" });

    expect((await memberFor("kiri.new@example.com"))).toMatchObject({ invited: true });
    expect((await auditFor("organisation.member_invited", ORG))).toMatchObject({ actor_email: "inv-admin@example.com", details: { email: "kiri.new@example.com", role: "viewer" } });
    expect((await auditFor("user.created", login.id)).details).toMatchObject({ isServerAdmin: false, invitedTo: ORG });
  });

  it("adds someone who already has a login as before: no email, no setup link, their own name kept", async () => {
    const linksBefore = await coreQuery("select 1 from user_setup_links where user_id = $1", [existing.id]);
    const response = await invite(admin, { email: "inv-existing@example.com", displayName: "Someone Else", role: "bookkeeper" });
    expect(response.status).toBe(201);
    const result = await json(response);
    expect(result).toMatchObject({ invited: false, invitation: null, member: { displayName: "Tama Existing", invited: false } });
    expect(sent).toHaveLength(0);
    expect((await coreQuery("select 1 from user_setup_links where user_id = $1", [existing.id])).rowCount).toBe(linksBefore.rowCount);
    expect((await auditFor("organisation.member_added", ORG)).details).toMatchObject({ email: "inv-existing@example.com" });
    // Resend and Cancel are only for invitations: they never reach an existing login.
    expect((await resend(admin, existing.id)).status).toBe(404);
    expect((await cancel(admin, existing.id)).status).toBe(404);
    const again = await invite(admin, { email: "inv-existing@example.com", displayName: "Tama", role: "viewer" });
    expect(again.status).toBe(400);
    expect((await json(again)).error).toMatch(/already a member/);
  });

  it("owners and admins invite; only owners invite owners", async () => {
    expect((await invite(bookkeeper, { email: "nope@example.com", displayName: "Nope", role: "viewer" })).status).toBe(403);
    expect((await invite(admin, { email: "would-be-owner@example.com", displayName: "Would Be", role: "owner" })).status).toBe(403);
    expect(await loginFor("nope@example.com")).toBeUndefined();
    expect(await loginFor("would-be-owner@example.com")).toBeUndefined();
    expect((await invite(admin, { email: "no-name@example.com", displayName: "", role: "viewer" })).status).toBe(400);
    const byOwner = await invite(owner, { email: "co-owner@example.com", displayName: "Hemi Co-owner", role: "owner" });
    expect(byOwner.status).toBe(201);
    const coOwner = await loginFor("co-owner@example.com");
    // An admin can't resend or cancel an owner's invitation.
    expect((await resend(admin, coOwner.id)).status).toBe(403);
    expect((await cancel(admin, coOwner.id)).status).toBe(403);
    expect((await resend(owner, coOwner.id)).status).toBe(200);
  });

  it("shows the inviter the link when the email can't be sent", async () => {
    emailWorks = false;
    const result = await json(await invite(admin, { email: "no-mail@example.com", displayName: "Sione No-mail", role: "viewer" }));
    expect(result.invitation).toMatchObject({ emailed: false });
    const url = (result.invitation as { url: string }).url;
    expect(url).toMatch(/\/login\/setup-account\?token=/);
    const state = await json(await setupAccountRoute.GET(apiRequest(`/api/auth/setup-account?token=${encodeURIComponent(tokenIn(url))}`), undefined as never));
    expect(state).toMatchObject({ valid: true, email: "no-mail@example.com" });
  });

  it("Resend makes a new link and stops the old one", async () => {
    await invite(admin, { email: "resend@example.com", displayName: "Ana Resend", role: "viewer" });
    const firstToken = tokenIn(sent[0].text);
    const login = await loginFor("resend@example.com");
    const response = await resend(admin, login.id);
    expect(response.status).toBe(200);
    expect((await json(response)).invitation).toMatchObject({ emailed: true, url: null });
    expect(sent).toHaveLength(2);
    const secondToken = tokenIn(sent[1].text);
    expect(secondToken).not.toBe(firstToken);
    const old = await json(await setupAccountRoute.GET(apiRequest(`/api/auth/setup-account?token=${encodeURIComponent(firstToken)}`), undefined as never));
    expect(old.valid).toBe(false);
    expect((await auditFor("organisation.invitation_resent", ORG)).details).toMatchObject({ email: "resend@example.com" });
  });

  it("stays Invited until they first sign in, then Resend and Cancel stop", async () => {
    await invite(admin, { email: "finish@example.com", displayName: "Wiremu Finish", role: "viewer" });
    const token = tokenIn(sent[0].text);
    const login = await loginFor("finish@example.com");
    // With two-step sign-in on, choosing a password isn't the end: they still have to set up their authenticator app.
    const chosen = await setupAccountRoute.POST(apiRequest("/api/auth/setup-account", { method: "POST", body: { token, password: "wiremus-own-password-1" } }), undefined as never);
    expect(chosen.status).toBe(200);
    expect((await memberFor("finish@example.com"))?.invited).toBe(true);
    // A full sign-in (here: the server without two-step sign-in, from a new link) ends "Invited".
    await resend(admin, login.id);
    const fresh = tokenIn(sent[1].text);
    delete process.env.TOHYEE_SECRET_KEY;
    try {
      const done = await setupAccountRoute.POST(apiRequest("/api/auth/setup-account", { method: "POST", body: { token: fresh, password: "wiremus-own-password-2" } }), undefined as never);
      expect(done.status).toBe(200);
    } finally {
      process.env.TOHYEE_SECRET_KEY = "member-invitations-test-key-0123456789abcdef";
    }
    expect((await memberFor("finish@example.com"))).toMatchObject({ invited: false, invitationSentAt: null });
    expect((await resend(admin, login.id)).status).toBe(404);
    expect((await cancel(admin, login.id)).status).toBe(404);
  });

  it("Cancel removes the membership, and the login when this invitation made it and nothing else uses it", async () => {
    await invite(admin, { email: "cancel-me@example.com", displayName: "Pita Cancel", role: "viewer" });
    const token = tokenIn(sent[0].text);
    const login = await loginFor("cancel-me@example.com");
    const response = await cancel(admin, login.id);
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ loginRemoved: true });
    expect(await loginFor("cancel-me@example.com")).toBeUndefined();
    expect(await memberFor("cancel-me@example.com")).toBeUndefined();
    const state = await json(await setupAccountRoute.GET(apiRequest(`/api/auth/setup-account?token=${encodeURIComponent(token)}`), undefined as never));
    expect(state.valid).toBe(false);
    expect((await auditFor("organisation.invitation_cancelled", ORG)).details).toMatchObject({ email: "cancel-me@example.com", loginRemoved: true });
  });

  it("Cancel keeps the login when another organisation has them too, and then the link only goes by email", async () => {
    await invite(admin, { email: "shared@example.com", displayName: "Lani Shared", role: "viewer" });
    const login = await loginFor("shared@example.com");
    // Another organisation adds the same address: it's an existing login there, so it's added as before.
    const there = await json(await invite(owner, { email: "shared@example.com", displayName: "Lani", role: "viewer" }, OTHER));
    expect(there).toMatchObject({ invited: false, invitation: null });
    // With email down, Resend no longer shows the link: someone else's organisation uses this login now.
    emailWorks = false;
    const resent = await json(await resend(admin, login.id));
    expect(resent.invitation).toMatchObject({ emailed: false, url: null });
    const response = await cancel(admin, login.id);
    expect(await json(response)).toEqual({ loginRemoved: false });
    expect(await loginFor("shared@example.com")).toMatchObject({ memberships: 1 });
    expect(await memberFor("shared@example.com", OTHER)).toBeDefined();
  });

  it("someone removed from every organisation keeps their login, as in Xero; a server admin can turn it off", async () => {
    const person = await createTestUser("leaving@example.com", { displayName: "Leaving Person" });
    await invite(admin, { email: "leaving@example.com", displayName: "Leaving Person", role: "viewer" });
    const removed = await memberRoute.DELETE(
      apiRequest(`/api/organisations/${ORG}/members/${person.id}`, { method: "DELETE", cookie: await cookie(admin) }),
      params({ organisationId: ORG, userId: person.id }),
    );
    expect(removed.status).toBe(200);
    expect(await loginFor("leaving@example.com")).toMatchObject({ is_active: true, memberships: 0 });
  });

  it("a new member in an organisation with several farms starts with no farms (decision 744)", async () => {
    const run = <T>(work: Parameters<typeof inOrganisation<T>>[2]) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    await run((tx) => saveFarm(tx, { name: "Home farm" }));
    await run((tx) => saveFarm(tx, { name: "Runoff" }));
    await invite(admin, { email: "farmhand@example.com", displayName: "Tui Farmhand", role: "viewer" });
    const login = await loginFor("farmhand@example.com");
    const scope = await inOrganisation(ORG, { userId: login.id, email: "farmhand@example.com" }, (tx) => farmScope(tx));
    expect(scope).toEqual({ all: false, farmIds: new Set() });
  });

  it("limits how many people an organisation adds or invites in an hour", async () => {
    const busy = "invite-busy";
    await createTestOrganisation(owner, busy);
    await coreQuery(
      `insert into admin_audit_events (event_type, entity_type, entity_id, actor_user_id, actor_email)
       select 'organisation.member_invited', 'organisation', $1, $2, $3 from generate_series(1, $4::int)`,
      [busy, owner.id, owner.email, INVITES_PER_HOUR],
    );
    const refused = await invite(owner, { email: "one-too-many@example.com", displayName: "One Too Many", role: "viewer" }, busy);
    expect(refused.status).toBe(429);
    expect(await loginFor("one-too-many@example.com")).toBeUndefined();
    // Adding an existing login counts as well, so it can't be used to check addresses quickly.
    expect((await invite(owner, { email: "inv-bookkeeper@example.com", displayName: "Mere", role: "viewer" }, busy)).status).toBe(429);
    // Other organisations aren't held up.
    expect((await invite(owner, { email: "elsewhere@example.com", displayName: "Elsewhere", role: "viewer" }, OTHER)).status).toBe(201);
  });
});
