import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as adminHandoverRoute from "@/app/api/admin/organisations/[organisationId]/handover/route";
import * as handoverRoute from "@/app/api/organisations/[organisationId]/handover/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import { type OutgoingEmail, setEmailSenderForTests, updateEmailSettings } from "@/lib/email/mailer";
import { listTopBarNotices } from "@/lib/notices/top-bar";
import { completeDueHandovers, waitingHandover } from "@/lib/organisations/handover";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

/**
 * "Hand over this organisation" (#208, decision 485): a server admin makes
 * someone else an owner after a 7-day wait that the organisation's owners
 * and admins are told about and can cancel. Not to the server admin.
 */
describeWithDatabase("organisation handover (#208)", () => {
  const org = "handover-co";
  let server: TestServer;
  let serverAdmin: SessionUser;
  let owner: SessionUser;
  let admin: SessionUser;
  let bookkeeper: SessionUser;
  let kim: SessionUser;
  const cookies = new Map<string, string>();
  const sent: OutgoingEmail[] = [];
  const originalKey = process.env.TOHYEE_SECRET_KEY;

  const ask = (user: SessionUser, payload: Record<string, unknown>) =>
    adminHandoverRoute.POST(
      apiRequest(`/api/admin/organisations/${org}/handover`, { method: "POST", cookie: cookies.get(user.email), body: payload }),
      params({ organisationId: org }),
    );

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "handover-test-key-0123456789abcdefghijk";
    server = await startTestServer();
    serverAdmin = await createTestUser("ho-server@example.com", { serverAdmin: true });
    owner = await createTestUser("ho-owner@example.com");
    admin = await createTestUser("ho-admin@example.com");
    bookkeeper = await createTestUser("ho-bookkeeper@example.com");
    kim = await createTestUser("ho-kim@example.com", { displayName: "Kim" });
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'bookkeeper')", [org, admin.id, bookkeeper.id]);
    for (const user of [serverAdmin, owner, admin, bookkeeper, kim]) cookies.set(user.email, await sessionCookieFor(user));
    setEmailSenderForTests(async (message) => {
      sent.push(message);
    });
    await updateEmailSettings({ user: { id: serverAdmin.id, email: serverAdmin.email, isServerAdmin: true } }, { host: "smtp.gmail.com", port: 465, username: "books@example.com", password: "app-password" });
  });

  afterEach(() => {
    sent.length = 0;
  });

  afterAll(async () => {
    setEmailSenderForTests(null);
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
  });

  it("is refused to yourself, to an unknown or existing owner, without a reason, and for anyone but a server admin", async () => {
    const self = await ask(serverAdmin, { email: serverAdmin.email, reason: "I'll look after it" });
    expect(self.status).toBe(400);
    expect((await body(self)).error).toContain("can't hand an organisation to themselves");
    expect((await ask(serverAdmin, { email: "nobody@example.com", reason: "The owner has died" })).status).toBe(400);
    expect((await ask(serverAdmin, { email: owner.email, reason: "The owner has died" })).status).toBe(409);
    expect((await ask(serverAdmin, { email: kim.email, reason: "no" })).status).toBe(400);
    expect((await ask(owner, { email: kim.email, reason: "The owner has died" })).status).toBe(403);
    expect(await waitingHandover(org)).toBeNull();
  });

  it("waits 7 days; owners and admins are emailed, see it in Tohyee and in its history; then Kim becomes an owner", async () => {
    const asked = await ask(serverAdmin, { email: kim.email, reason: "The owner has died; Kim is the executor's accountant." });
    expect(asked.status).toBe(201);
    const handover = (await body(asked)).handover as { takesEffectAt: string; status: string };
    expect(handover.status).toBe("waiting");
    const days = (new Date(handover.takesEffectAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    expect(sent.map((email) => email.to).sort()).toEqual([admin.email, owner.email]);
    expect(sent[0].text).toContain("The owner has died; Kim is the executor's accountant.");
    expect(sent[0].text).toContain("unless an owner or admin cancels it");

    // Only one at a time.
    expect((await ask(serverAdmin, { email: bookkeeper.email, reason: "Someone else instead" })).status).toBe(409);

    // Owners and admins see it; a bookkeeper doesn't.
    const seen = await handoverRoute.GET(apiRequest(`/api/organisations/${org}/handover`, { cookie: cookies.get(admin.email) }), params({ organisationId: org }));
    expect((await body(seen)).handover).toMatchObject({ toEmail: kim.email, requestedByEmail: serverAdmin.email });
    expect((await handoverRoute.GET(apiRequest(`/api/organisations/${org}/handover`, { cookie: cookies.get(bookkeeper.email) }), params({ organisationId: org }))).status).toBe(403);
    const asAdmin = await inOrganisation(org, { userId: admin.id, email: admin.email }, (tx) => listTopBarNotices(tx, "admin"));
    expect(asAdmin).toContainEqual(expect.objectContaining({ id: "organisation-handover", href: "/operations/members" }));
    const asBookkeeper = await inOrganisation(org, { userId: bookkeeper.id, email: bookkeeper.email }, (tx) => listTopBarNotices(tx, "bookkeeper"));
    expect(asBookkeeper).not.toContainEqual(expect.objectContaining({ id: "organisation-handover" }));
    const history = await inOrganisation(org, { userId: admin.id, email: admin.email }, (tx) =>
      tx.query<{ event_type: string; actor_email: string }>("select event_type, actor_email from audit_events where event_type like 'organisation.handover%' order by id"),
    );
    expect(history.rows).toEqual([{ event_type: "organisation.handover_requested", actor_email: serverAdmin.email }]);

    // Not before the 7 days are up.
    expect(await completeDueHandovers(new Date(Date.now() + 6 * 86_400_000))).toBe(0);
    expect(await completeDueHandovers(new Date(Date.now() + 7 * 86_400_000 + 60_000))).toBe(1);
    const role = await coreQuery<{ role: string }>("select role from organisation_members where organisation_id = $1 and user_id = $2", [org, kim.id]);
    expect(role.rows[0].role).toBe("owner");
    // Nobody lost access.
    const members = await coreQuery<{ count: string }>("select count(*)::text as count from organisation_members where organisation_id = $1", [org]);
    expect(members.rows[0].count).toBe("4");
    expect(sent.some((email) => email.subject.includes("handed over") && email.text.includes("Kim (ho-kim@example.com) is now an owner"))).toBe(true);
    expect(await waitingHandover(org)).toBeNull();
    expect(await completeDueHandovers(new Date(Date.now() + 30 * 86_400_000))).toBe(0);
    const after = await inOrganisation(org, { userId: admin.id, email: admin.email }, (tx) =>
      tx.query<{ event_type: string }>("select event_type from audit_events where event_type like 'organisation.handover%' order by id"),
    );
    expect(after.rows.map((row) => row.event_type)).toEqual(["organisation.handover_requested", "organisation.handover_done"]);
  });

  it("an owner or admin can cancel it, and so can the server admin; nothing changes", async () => {
    expect((await ask(serverAdmin, { email: bookkeeper.email, reason: "Testing a cancel" })).status).toBe(201);
    const cancelled = await handoverRoute.DELETE(
      apiRequest(`/api/organisations/${org}/handover`, { method: "DELETE", cookie: cookies.get(admin.email) }),
      params({ organisationId: org }),
    );
    expect(cancelled.status).toBe(200);
    expect((await body(cancelled)).handover).toMatchObject({ status: "cancelled", cancelledByEmail: admin.email });
    expect(sent.some((email) => email.to === serverAdmin.email && email.subject.includes("cancelled"))).toBe(true);
    expect(await completeDueHandovers(new Date(Date.now() + 30 * 86_400_000))).toBe(0);
    const role = await coreQuery<{ role: string }>("select role from organisation_members where organisation_id = $1 and user_id = $2", [org, bookkeeper.id]);
    expect(role.rows[0].role).toBe("bookkeeper");

    expect((await ask(serverAdmin, { email: bookkeeper.email, reason: "Testing a cancel again" })).status).toBe(201);
    const byServer = await adminHandoverRoute.DELETE(
      apiRequest(`/api/admin/organisations/${org}/handover`, { method: "DELETE", cookie: cookies.get(serverAdmin.email) }),
      params({ organisationId: org }),
    );
    expect(byServer.status).toBe(200);
    expect(await waitingHandover(org)).toBeNull();
  });
});
