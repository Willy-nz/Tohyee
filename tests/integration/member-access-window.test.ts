import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as noticesRoute from "@/app/api/notices/route";
import * as accessRoute from "@/app/api/organisations/[organisationId]/members/[userId]/access/route";
import * as activityRoute from "@/app/api/organisations/[organisationId]/members/[userId]/activity/route";
import * as membersRoute from "@/app/api/organisations/[organisationId]/members/route";
import * as sessionRoute from "@/app/api/auth/session/route";
import { authenticateAiToken } from "@/lib/ai/tokens";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import { authenticateFarmAppKey, createFarmAppKey } from "@/lib/farm-apps/keys";
import { queueAccessReminders } from "@/lib/organisations/access";
import type { Member } from "@/lib/organisations/members";
import { getMembership, listMembershipsForUser } from "@/lib/organisations/registry";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "access-org";
const OTHER = "access-other";
const noContext = undefined as unknown;

type Json = Record<string, unknown>;
const json = async (response: Response) => (await response.json()) as Json;

function mcpRequest(token: string): Request {
  return new Request("http://tohyee.test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
}

/**
 * Time-limited access (decisions 1466-1474). Every person and address is
 * made up; email is never sent.
 */
describeWithDatabase("time-limited access for members", () => {
  let server: TestServer;
  let owner: SessionUser;
  let secondOwner: SessionUser;
  let admin: SessionUser;
  let hired: SessionUser;
  const cookies = new Map<string, string>();
  const cookie = async (user: SessionUser) => {
    if (!cookies.has(user.id)) cookies.set(user.id, await sessionCookieFor(user));
    return cookies.get(user.id)!;
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("acc-owner@example.com", { serverAdmin: true, displayName: "Aroha Owner" });
    secondOwner = await createTestUser("acc-owner2@example.com", { displayName: "Wiremu Owner" });
    admin = await createTestUser("acc-admin@example.com", { displayName: "Rangi Admin" });
    hired = await createTestUser("acc-hired@example.com", { displayName: "Kiri Bookkeeper" });
    await createTestOrganisation(owner, ORG);
    await createTestOrganisation(owner, OTHER);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'admin')", [ORG, admin.id]);
    // The hired bookkeeper is in another organisation too, with no dates.
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [OTHER, hired.id]);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const setWindow = (starts: string | null, ends: string | null, userId = hired.id, organisationId = ORG) =>
    coreQuery("update organisation_members set access_starts_at = $3, access_ends_at = $4 where organisation_id = $1 and user_id = $2", [organisationId, userId, starts, ends]);
  const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const membersOf = async (as: SessionUser = owner) =>
    ((await json(await membersRoute.GET(apiRequest(`/api/organisations/${ORG}/members`, { cookie: await cookie(as) }), params({ organisationId: ORG })))).members as Member[]);
  const notices = async (as: SessionUser, organisationId = ORG) =>
    noticesRoute.GET(apiRequest(`/api/notices?organisationId=${organisationId}`, { cookie: await cookie(as) }), noContext as never);
  const putAccess = async (as: SessionUser, userId: string, body: Json) =>
    accessRoute.PUT(apiRequest(`/api/organisations/${ORG}/members/${userId}/access`, { method: "PUT", cookie: await cookie(as), body }), params({ organisationId: ORG, userId }));
  const postAccess = async (as: SessionUser, userId: string, action: string) =>
    accessRoute.POST(apiRequest(`/api/organisations/${ORG}/members/${userId}/access`, { method: "POST", cookie: await cookie(as), body: { action } }), params({ organisationId: ORG, userId }));

  let aiKey: string;
  let farmKey: string;

  it("an admin invites someone with dates, and the list shows them", async () => {
    const response = await membersRoute.POST(
      apiRequest(`/api/organisations/${ORG}/members`, {
        method: "POST",
        cookie: await cookie(admin),
        body: { email: "acc-hired@example.com", displayName: "Kiri", role: "bookkeeper", accessFrom: "2026-01-01", accessUntil: "2099-12-12", accessUntilTime: "17:00" },
      }),
      params({ organisationId: ORG }),
    );
    expect(response.status).toBe(201);
    const member = (await membersOf()).find((entry) => entry.userId === hired.id)!;
    expect(member).toMatchObject({ accessState: "current", accessFrom: { date: "2026-01-01", time: null }, accessUntil: { date: "2099-12-12", time: "17:00" } });
    const audit = await coreQuery<{ details: Json }>("select details from admin_audit_events where event_type = 'organisation.member_added' and entity_id = $1 order by id desc limit 1", [ORG]);
    expect(audit.rows[0].details).toMatchObject({ accessUntil: "12 Dec 2099, 5:00pm" });

    // While it's current, everything works: pages, an AI key, a farm app key.
    expect((await notices(hired)).status).toBe(200);
    const made = await tokensRoute.POST(apiRequest("/api/ai/tokens", { method: "POST", cookie: await cookie(hired), body: { organisationId: ORG, name: "Kiri's AI" } }), noContext as never);
    expect(made.status).toBe(201);
    aiKey = (await json(made)).token as string;
    expect(await authenticateAiToken(aiKey)).not.toBeNull();
    expect((await mcpRoute.POST(mcpRequest(aiKey), noContext as never)).status).toBe(200);
    farmKey = (await createFarmAppKey({ sessionId: "made-up", user: hired }, ORG, { name: "Paddock app", scopes: ["read_farm"], role: "bookkeeper" })).key;
    expect(await authenticateFarmAppKey(farmKey)).not.toBeNull();
  });

  it("after the end, every request, key and AI connection is refused, with a plain message", async () => {
    await setWindow(null, new Date(Date.now() - 60_000).toISOString());
    const refused = await notices(hired);
    expect(refused.status).toBe(403);
    const body = await json(refused);
    expect(body.code).toBe("access_ended");
    expect(body.error).toMatch(/^Your access to Test access-org ended on \d{1,2} [A-Z][a-z]{2} \d{4}(, \d{1,2}:\d{2}(am|pm))?\. Ask Aroha Owner to extend it\.$/);

    expect(await getMembership(ORG, hired.id)).toBeNull();
    expect((await listMembershipsForUser(hired.id)).map((m) => m.organisation.id)).toEqual([OTHER]);
    expect(await authenticateAiToken(aiKey)).toBeNull();
    expect(await authenticateFarmAppKey(farmKey)).toBeNull();
    const mcp = await mcpRoute.POST(mcpRequest(aiKey), noContext as never);
    expect(mcp.status).toBe(403);
    expect(JSON.stringify(await mcp.json())).toContain("Your access to Test access-org ended on");
    // A new AI app can't be connected either: the AI key route checks the membership.
    const another = await tokensRoute.POST(apiRequest("/api/ai/tokens", { method: "POST", cookie: await cookie(hired), body: { organisationId: ORG, name: "Again" } }), noContext as never);
    expect(another.status).toBe(403);

    // Nothing is deleted: they stay listed as ended, and the key isn't revoked.
    expect((await membersOf()).find((entry) => entry.userId === hired.id)?.accessState).toBe("ended");
    expect((await coreQuery("select 1 from ai_access_tokens where token_hash is not null and user_id = $1 and revoked_at is null", [hired.id])).rowCount).toBe(1);
    // The session list says why the organisation is missing.
    const session = await json(await sessionRoute.GET(apiRequest("/api/auth/session", { cookie: await cookie(hired) }), noContext as never));
    expect((session.organisations as Json[]).map((o) => o.id)).toEqual([OTHER]);
  });

  it("another organisation the same person belongs to is unaffected", async () => {
    expect((await notices(hired, OTHER)).status).toBe(200);
    expect(await getMembership(OTHER, hired.id)).not.toBeNull();
  });

  it("before the start, they're refused too", async () => {
    await setWindow(inHours(24), inHours(48));
    const refused = await notices(hired);
    expect(refused.status).toBe(403);
    const body = await json(refused);
    expect(body.code).toBe("access_not_started");
    expect(body.error).toMatch(/^Your access to Test access-org starts on .+\. Ask Aroha Owner if you need it sooner\.$/);
    expect(await authenticateAiToken(aiKey)).toBeNull();
  });

  it("Extend brings access (and the same keys) back; End now stops it", async () => {
    await setWindow(null, new Date(Date.now() - 60_000).toISOString());
    const extended = await postAccess(admin, hired.id, "extend_week");
    expect(extended.status).toBe(200);
    const member = (await json(extended)).member as Member;
    expect(member.accessState).toBe("current");
    expect(new Date(member.accessEndsAt!).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect((await notices(hired)).status).toBe(200);
    expect(await authenticateAiToken(aiKey)).not.toBeNull();
    expect((await mcpRoute.POST(mcpRequest(aiKey), noContext as never)).status).toBe(200);

    const month = await json(await postAccess(admin, hired.id, "extend_month"));
    expect(new Date((month.member as Member).accessEndsAt!).getTime()).toBeGreaterThan(new Date(member.accessEndsAt!).getTime() + 27 * 86_400_000);

    const ended = await postAccess(admin, hired.id, "end_now");
    expect(ended.status).toBe(200);
    expect(((await json(ended)).member as Member).accessState).toBe("ended");
    expect((await notices(hired)).status).toBe(403);
    expect(await authenticateAiToken(aiKey)).toBeNull();
    const audit = await coreQuery<{ event_type: string }>("select event_type from admin_audit_events where entity_id = $1 and event_type like 'organisation.member_access_%' order by id", [ORG]);
    expect(audit.rows.map((row) => row.event_type)).toEqual(["organisation.member_access_extended", "organisation.member_access_extended", "organisation.member_access_ended"]);

    // Choosing dates: empty means no limit.
    const cleared = await putAccess(admin, hired.id, { accessFrom: "", accessUntil: "" });
    expect(((await json(cleared)).member as Member).accessState).toBe("open");
    expect((await putAccess(admin, hired.id, { accessFrom: "2099-01-02", accessUntil: "2099-01-01" })).status).toBe(400);
    // Someone who isn't an admin can't change anyone's dates, their own included.
    expect((await putAccess(hired, hired.id, { accessUntil: "2099-12-31" })).status).toBe(403);
  });

  it("the last owner with no end date can't be given one; an admin can't change an owner's dates", async () => {
    const own = await putAccess(owner, owner.id, { accessUntil: "2099-12-31" });
    expect(own.status).toBe(400);
    expect((await json(own)).error).toBe("At least one owner must keep access with no end date. Make someone else an owner first.");
    expect((await postAccess(owner, owner.id, "end_now")).status).toBe(400);
    expect((await putAccess(admin, owner.id, { accessUntil: "2099-12-31" })).status).toBe(403);

    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'owner')", [ORG, secondOwner.id]);
    expect((await putAccess(owner, secondOwner.id, { accessUntil: "2099-12-31" })).status).toBe(200);
    // Now the other owner is time-limited, so the first still can't be.
    expect((await putAccess(owner, owner.id, { accessUntil: "2099-12-31" })).status).toBe(400);
    // And the open-ended owner can't be made something else while the other one ends.
    expect((await coreQuery("select access_ends_at from organisation_members where organisation_id = $1 and user_id = $2", [ORG, owner.id])).rows[0].access_ends_at).toBeNull();
    await putAccess(owner, secondOwner.id, { accessUntil: "" });
  });

  it("reminds the member and the owners and admins 3 days before, once per end date, and shows notices", async () => {
    await setWindow(null, inHours(30));
    const queue = () => inOrganisation(ORG, { userId: null, email: "email job" }, (tx) => queueAccessReminders(tx, "https://books.example.com", "Test access-org"));
    expect(await queue()).toBe(4); // Kiri, both owners and the admin.
    expect(await queue()).toBe(0);
    const emails = await inOrganisation(ORG, { userId: null, email: "test" }, (tx) =>
      tx.query<{ to_email: string; subject: string; body: string }>("select to_email, subject, body from access_emails order by to_email"),
    );
    expect(emails.rows.map((row) => row.to_email)).toEqual(["acc-admin@example.com", "acc-hired@example.com", "acc-owner2@example.com", "acc-owner@example.com"]);
    const toAdmin = emails.rows[0];
    expect(toAdmin.subject).toBe("Kiri Bookkeeper's access to Test access-org ends soon");
    expect(toAdmin.body).toContain("https://books.example.com/operations/members?access=ending");
    expect(emails.rows[1].subject).toBe("Your access to Test access-org ends soon");

    const adminNotices = (await json(await notices(admin))).notices as Json[];
    expect(adminNotices.find((notice) => notice.id === `access-ending-${hired.id}`)).toMatchObject({ href: "/operations/members?access=ending" });
    const ownNotices = (await json(await notices(hired))).notices as Json[];
    expect(ownNotices.map((notice) => notice.id)).toContain("access-ending-you");
    expect(ownNotices.some((notice) => String(notice.id).startsWith(`access-ending-${hired.id}`))).toBe(false);

    // A new end brings a new reminder before it.
    await postAccess(admin, hired.id, "extend_week");
    await setWindow(null, inHours(50));
    expect(await queue()).toBe(4);
    await setWindow(null, null);
  });

  it("'What they did' lists the member's own actions for admins only", async () => {
    await inOrganisation(ORG, { userId: hired.id, email: hired.email }, (tx) =>
      tx.query("insert into audit_events (event_type, entity_type, entity_id, actor_user_id, actor_email, details) values ('bank_line.matched', 'bank_line', '1', $1, $2, '{}'), ('private_mail.copy_deleted', 'private_mail_copy', '2', $1, $2, '{}')", [hired.id, hired.email]),
    );
    const get = async (as: SessionUser) =>
      activityRoute.GET(apiRequest(`/api/organisations/${ORG}/members/${hired.id}/activity`, { cookie: await cookie(as) }), params({ organisationId: ORG, userId: hired.id }));
    const response = await get(admin);
    expect(response.status).toBe(200);
    const body = await json(response);
    const whats = (body.entries as Json[]).map((entry) => entry.what);
    expect(whats).toContain("Bank line matched");
    expect(whats).toContain("AI access token created");
    expect(whats.some((what) => String(what).startsWith("Private mail"))).toBe(false);
    expect((await get(hired)).status).toBe(403);
  });
});

