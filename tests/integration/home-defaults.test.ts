import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { crmScope } from "@/lib/crm/access";
import { salesHome } from "@/lib/crm/sales-home";
import { createOpportunity, createTask } from "@/lib/crm/service";
import { addDays } from "@/lib/financial-year";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import * as preferencesRoute from "@/app/api/dashboard-preferences/route";
import * as salesHomeRoute from "@/app/api/crm/sales-home/route";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "home-defaults";

type Preference = { hidden: boolean; tiles: string[]; customised: boolean; kind: string; defaultTiles: string[] };

/** Starting dashboards by kind of person (decision 660, HD1-HD5) and the CRM Home's sales cards (decision 662, SD1-SD6). Made-up people and deals. */
describeWithDatabase("starting dashboards and the CRM Home", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let rep: SessionUser;
  let otherRep: SessionUser;
  const today = todayIsoDate();
  const asOwner = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const as = <T>(user: SessionUser, role: "sales_rep" | "owner", work: (tx: OrgTx, scope: Awaited<ReturnType<typeof crmScope>>) => Promise<T>) =>
    inOrganisation(ORG, { userId: user.id, email: user.email }, async (tx) => work(tx, await crmScope(tx, role, user.id)));

  const get = async (user: SessionUser, page: string) => {
    const response = await preferencesRoute.GET(apiRequest(`/api/dashboard-preferences?organisationId=${ORG}&page=${page}`, { cookie: await sessionCookieFor(user) }), undefined as never);
    return { status: response.status, body: (await response.json()) as Preference };
  };
  const put = async (user: SessionUser, page: string, tiles: string[]) => {
    const response = await preferencesRoute.PUT(apiRequest("/api/dashboard-preferences", { method: "PUT", cookie: await sessionCookieFor(user), body: { organisationId: ORG, page, hidden: false, tiles } }), undefined as never);
    return { status: response.status, body: (await response.json()) as Preference };
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("home-defaults-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    viewer = await createTestUser("home-defaults-viewer@example.com", { displayName: "Vic Viewer" });
    rep = await createTestUser("home-defaults-rep@example.com", { displayName: "Ruby Rep" });
    otherRep = await createTestUser("home-defaults-other@example.com", { displayName: "Otto Rep" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer'), ($1, $3, 'sales_rep'), ($1, $4, 'sales_rep')", [ORG, viewer.id, rep.id, otherRep.id]);
    await asOwner((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("HD2, HD5 Home's starting tiles follow GST registration and the CRM; a person's own choice always wins", async () => {
    // Registered for GST (the default): the GST card.
    const first = await get(owner, "home");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ kind: "owner", customised: false, tiles: ["cash_in_bank", "owed_to_you", "bills_to_pay", "next_gst_return"] });
    // Jess picks her own.
    const mine = ["bills_to_pay", "cash_in_bank", "owed_to_you", "next_gst_return"];
    expect((await put(owner, "home", mine)).body).toMatchObject({ tiles: mine, customised: true });
    // Not registered and the CRM on: the sales pipeline, for anyone who hasn't chosen.
    await asOwner((tx) => updateOrganisationSettings(tx, { gstRegistered: false }));
    expect((await get(viewer, "home")).body).toMatchObject({ kind: "owner", customised: false, tiles: ["cash_in_bank", "owed_to_you", "bills_to_pay", "sales_pipeline"] });
    expect((await get(owner, "home")).body).toMatchObject({ tiles: mine, customised: true, defaultTiles: ["cash_in_bank", "owed_to_you", "bills_to_pay", "sales_pipeline"] });
    // Back to the starting cards.
    const reset = await preferencesRoute.DELETE(
      apiRequest(`/api/dashboard-preferences?organisationId=${ORG}&page=home`, { method: "DELETE", cookie: await sessionCookieFor(owner) }),
      undefined as never,
    );
    expect(reset.status).toBe(200);
    expect((await get(owner, "home")).body).toMatchObject({ customised: false, tiles: ["cash_in_bank", "owed_to_you", "bills_to_pay", "sales_pipeline"] });
    // A card the page doesn't offer is refused.
    expect((await put(owner, "home", ["no_such_card"])).status).toBe(400);
  });

  it("HD1, HD4 a sales rep gets the CRM Home starting with next actions, can change it, and can't open Home's", async () => {
    const start = await get(rep, "crm_home");
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ kind: "sales", customised: false });
    expect(start.body.tiles[0]).toBe("next_actions");
    expect((await get(owner, "crm_home")).body.tiles.slice(0, 2)).toEqual(["pipeline", "conversion"]);
    const saved = await put(rep, "crm_home", ["pipeline", "next_actions"]);
    expect(saved.status).toBe(200);
    expect((await get(rep, "crm_home")).body).toMatchObject({ tiles: ["pipeline", "next_actions"], customised: true });
    // Ruby's choice is hers alone.
    expect((await get(otherRep, "crm_home")).body).toMatchObject({ customised: false, tiles: start.body.tiles });
    expect((await get(rep, "home")).status).toBe(403);
    expect((await get(rep, "farm_home")).status).toBe(403);
  });

  it("SD1-SD4 the pipeline and conversion are only what the person may see; next actions are only their own", async () => {
    const contactId = (await asOwner((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Vets", isProspect: true }))).contact.id;
    const deal = (name: string, ownerUserId: string, amount: string, closeDate: string, stage = "proposal") =>
      asOwner((tx) => createOpportunity(tx, { name, contactId, ownerUserId, amount, closeDate, stage }));
    const late = await deal("Keyrings", rep.id, "600.00", addDays(today, -3));
    const quiet = await deal("Collars", rep.id, "400.00", addDays(today, 30), "meeting");
    const ottos = await deal("Otto's tags", otherRep.id, "900.00", addDays(today, -1));
    // Ruby has a task on Keyrings due yesterday; Otto one due today.
    await as(rep, "sales_rep", (tx, scope) => createTask(tx, { title: "Chase the PO", opportunityId: late.id, assigneeUserId: rep.id, dueDate: addDays(today, -1) }, scope));
    await as(otherRep, "sales_rep", (tx, scope) => createTask(tx, { title: "Otto's call", opportunityId: ottos.id, assigneeUserId: otherRep.id, dueDate: today }, scope));

    const ruby = await as(rep, "sales_rep", (tx, scope) => salesHome(tx, scope, { today }));
    expect(ruby.scoped).toBe(true);
    expect(ruby.pipeline).toMatchObject({ count: 2, totals: [{ currencyCode: "NZD", amount: "1000.00" }] });
    expect(ruby.nextActions.tasks).toEqual({ count: 1, items: [expect.objectContaining({ title: "Chase the PO", overdue: true, href: `/crm/opportunities/${late.id}`, about: "Keyrings" })] });
    expect(ruby.nextActions.pastClose.items.map((item) => item.name)).toEqual(["Keyrings"]);
    // Collars has no task still to do; Keyrings has one.
    expect(ruby.nextActions.noNextStep.items.map((item) => item.id)).toEqual([quiet.id]);
    expect(JSON.stringify(ruby)).not.toContain("Otto's");

    const jess = await as(owner, "owner", (tx, scope) => salesHome(tx, scope, { today }));
    expect(jess.scoped).toBe(false);
    expect(jess.pipeline).toMatchObject({ count: 3, totals: [{ currencyCode: "NZD", amount: "1900.00" }] });
    // Jess owns none, so has no next actions of her own.
    expect(jess.nextActions).toEqual({ tasks: { count: 0, items: [] }, pastClose: { count: 0, items: [] }, noNextStep: { count: 0, items: [] } });
    expect(jess.conversion).toHaveLength(2);

    // Through the route as Otto: his own only.
    const response = await salesHomeRoute.GET(apiRequest(`/api/crm/sales-home?organisationId=${ORG}`, { cookie: await sessionCookieFor(otherRep) }), undefined as never);
    expect(response.status).toBe(200);
    const otto = (await response.json()) as typeof ruby;
    expect(otto.pipeline.count).toBe(1);
    expect(otto.nextActions.tasks.items.map((item) => item.title)).toEqual(["Otto's call"]);
    expect(JSON.stringify(otto)).not.toContain("Chase the PO");
  });
});
