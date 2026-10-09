import { afterAll, beforeAll, expect, it } from "vitest";
import * as contactRoute from "@/app/api/contacts/[contactId]/route";
import * as contactsRoute from "@/app/api/contacts/route";
import * as companyRoute from "@/app/api/crm/companies/[contactId]/route";
import * as companiesRoute from "@/app/api/crm/companies/route";
import * as forecastsRoute from "@/app/api/crm/forecasts/route";
import * as homeRoute from "@/app/api/crm/home/route";
import * as invoiceFromDealRoute from "@/app/api/crm/opportunities/[opportunityId]/invoice/route";
import * as opportunityRoute from "@/app/api/crm/opportunities/[opportunityId]/route";
import * as opportunitiesRoute from "@/app/api/crm/opportunities/route";
import * as tasksRoute from "@/app/api/crm/tasks/route";
import * as teamRoute from "@/app/api/crm/teams/[teamId]/route";
import * as teamsRoute from "@/app/api/crm/teams/route";
import * as invoicesRoute from "@/app/api/invoices/route";
import * as notesRoute from "@/app/api/records/[recordType]/[recordId]/notes/route";
import * as searchRoute from "@/app/api/search/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import { crmAllows, isSalesRole, roleAtLeast } from "@/lib/auth/roles";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { createActivity, createOpportunity, createTask } from "@/lib/crm/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const ORG = "sales-roles";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

/** Decision 491 (#216): Sales rep and Sales manager roles, sales teams and who sees which CRM records. */
describeWithDatabase("CRM sales roles and teams (decision 491)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let rep: SessionUser;
  let otherRep: SessionUser;
  let manager: SessionUser;
  let viewer: SessionUser;
  const ids: Record<string, string> = {};

  const asOwner = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const get = async (user: SessionUser, path: string) => apiRequest(`${path}${path.includes("?") ? "&" : "?"}organisationId=${ORG}`, { cookie: await sessionCookieFor(user) });
  const send = async (user: SessionUser, path: string, method: string, body: Json) =>
    apiRequest(path, { method, cookie: await sessionCookieFor(user), body: { organisationId: ORG, ...body } });
  const bodyOf = async (response: Response) => (await response.json()) as Json;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    rep = await createTestUser("rep@example.com", { displayName: "Ruby Rep" });
    otherRep = await createTestUser("other@example.com", { displayName: "Otto Rep" });
    manager = await createTestUser("manager@example.com", { displayName: "Mere Manager" });
    viewer = await createTestUser("viewer@example.com", { displayName: "Vic Viewer" });
    // Added as viewers, then given the sales roles (the database's role check allows them, core migration 0013).
    for (const user of [rep, otherRep, manager, viewer]) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, user.id]);
    }
    await coreQuery("update organisation_members set role = 'sales_rep' where organisation_id = $1 and user_id = any($2::uuid[])", [ORG, [rep.id, otherRep.id]]);
    await coreQuery("update organisation_members set role = 'sales_manager' where organisation_id = $1 and user_id = $2", [ORG, manager.id]);

    await asOwner((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    const vets = (await asOwner((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Mānuka Vets", isCustomer: true }))).contact;
    ids.vets = vets.id;
    const deal = (owner: SessionUser, name: string) =>
      asOwner((tx) => createOpportunity(tx, { name, contactId: vets.id, ownerUserId: owner.id, amount: "1000.00", closeDate: "2026-10-31" }));
    ids.repDeal = (await deal(rep, "Ruby's deal")).id;
    ids.otherDeal = (await deal(otherRep, "Otto's deal")).id;
    ids.ownerDeal = (await deal(owner, "Jess's deal")).id;
    ids.repTask = (await asOwner((tx) => createTask(tx, { title: "Ruby's call", assigneeUserId: rep.id, contactId: vets.id }))).id;
    ids.otherTask = (await asOwner((tx) => createTask(tx, { title: "Otto's call", assigneeUserId: otherRep.id, contactId: vets.id }))).id;
    await asOwner((tx) => createActivity(tx, { kind: "note", subject: "About Otto's deal", opportunityId: ids.otherDeal }));
    await asOwner((tx) => createActivity(tx, { kind: "call", subject: "Company call", contactId: vets.id }));
    const invoice = await asOwner(async (tx) => {
      const drafted = await createInvoice(tx, {
        idempotencyKey: key("i"),
        contactId: vets.id,
        invoiceDate: "2026-10-01",
        dueDate: "2026-10-20",
        amountsMode: "exclusive",
        lines: [{ description: "Consulting", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST" }],
      });
      return (await approveInvoice(tx, drafted.invoice.id, { idempotencyKey: key("a") })).invoice;
    });
    ids.invoice = invoice.id;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("the roles: CRM only, below everything else", () => {
    expect(isSalesRole("sales_rep")).toBe(true);
    expect(roleAtLeast("sales_manager", "report_viewer")).toBe(false);
    expect(crmAllows("sales_rep", "write")).toBe(true);
    expect(crmAllows("sales_manager", "admin")).toBe(false);
    expect(crmAllows("report_viewer", "read")).toBe(false);
    expect(crmAllows("viewer", "write")).toBe(false);
  });

  it("a sales rep can't reach the books, the settings or invoice making", async () => {
    expect((await invoicesRoute.GET(await get(rep, "/api/invoices"), noContext)).status).toBe(403);
    expect((await settingsRoute.GET(await get(rep, `/api/organisations/${ORG}/settings`), params({ organisationId: ORG }))).status).toBe(403);
    const made = await invoiceFromDealRoute.POST(await send(rep, `/api/crm/opportunities/${ids.repDeal}/invoice`, "POST", {}), params({ opportunityId: ids.repDeal }));
    expect(made.status).toBe(403);
    const invoiceNote = await notesRoute.POST(
      await send(rep, `/api/records/invoice/${ids.invoice}/notes`, "POST", { body: "Hi", idempotencyKey: key("n") }),
      params({ recordType: "invoice", recordId: ids.invoice }),
    );
    expect(invoiceNote.status).toBe(403);
  });

  it("everyone in sales sees every company, but only their own deals and tasks; a viewer sees all", async () => {
    const companies = (await bodyOf(await companiesRoute.GET(await get(rep, "/api/crm/companies"), noContext))).companies as Json[];
    expect(companies.map((company) => company.name)).toContain("Mānuka Vets");
    // The company's open pipeline is only Ruby's deal for Ruby.
    expect(companies.find((company) => company.name === "Mānuka Vets")).toMatchObject({ openPipeline: "1000.00", openTasks: 1 });
    const names = async (user: SessionUser) =>
      ((await bodyOf(await opportunitiesRoute.GET(await get(user, "/api/crm/opportunities"), noContext))).opportunities as Json[]).map((o) => o.name).sort();
    expect(await names(rep)).toEqual(["Ruby's deal"]);
    expect(await names(viewer)).toEqual(["Jess's deal", "Otto's deal", "Ruby's deal"]);
    const tasks = (await bodyOf(await tasksRoute.GET(await get(rep, "/api/crm/tasks"), noContext))).tasks as Json[];
    expect(tasks.map((task) => task.title)).toEqual(["Ruby's call"]);
    const contacts = (await bodyOf(await contactsRoute.GET(await get(rep, "/api/contacts"), noContext))).contacts as Json[];
    expect(contacts.map((contact) => contact.name)).toContain("Mānuka Vets");
  });

  it("another rep's deal is 'not found', and a rep can't give a deal to someone else", async () => {
    expect((await opportunityRoute.GET(await get(rep, `/api/crm/opportunities/${ids.otherDeal}`), params({ opportunityId: ids.otherDeal }))).status).toBe(404);
    const patched = await opportunityRoute.PATCH(await send(rep, `/api/crm/opportunities/${ids.otherDeal}`, "PATCH", { amount: "1.00" }), params({ opportunityId: ids.otherDeal }));
    expect(patched.status).toBe(404);
    const created = await opportunitiesRoute.POST(await send(rep, "/api/crm/opportunities", "POST", { name: "New lead", contactId: ids.vets }), noContext);
    expect(created.status).toBe(201);
    expect(((await bodyOf(created)).opportunity as Json).ownerUserId).toBe(rep.id);
    const forOtto = await opportunitiesRoute.POST(await send(rep, "/api/crm/opportunities", "POST", { name: "Not mine", contactId: ids.vets, ownerUserId: otherRep.id }), noContext);
    expect(forOtto.status).toBe(403);
  });

  it("a rep's company page has no books, and hides activities on others' deals", async () => {
    const page = await bodyOf(await companyRoute.GET(await get(rep, `/api/crm/companies/${ids.vets}`), params({ contactId: ids.vets })));
    expect(page).toMatchObject({ invoices: [], invoiceCount: 0, creditNotes: [] });
    const kinds = (page.timeline as Json[]).map((entry) => entry.kind);
    expect(kinds).not.toContain("invoice");
    const titles = (page.activities as Json[]).map((activity) => activity.subject);
    expect(titles).toContain("Company call");
    expect(titles).not.toContain("About Otto's deal");
    const viewerPage = await bodyOf(await companyRoute.GET(await get(viewer, `/api/crm/companies/${ids.vets}`), params({ contactId: ids.vets })));
    expect(viewerPage.invoiceCount).toBe(1);
    const home = await bodyOf(await homeRoute.GET(await get(rep, "/api/crm/home"), noContext));
    expect((home.activities as Json[]).map((activity) => activity.subject)).not.toContain("About Otto's deal");
  });

  it("a rep adds prospects and changes contact details only; notes on a company are fine", async () => {
    const added = await contactsRoute.POST(await send(rep, "/api/contacts", "POST", { name: "Kea Pets", email: "hi@keapets.nz", idempotencyKey: key("c") }), noContext);
    expect(added.status).toBe(201);
    expect((await bodyOf(added)).contact).toMatchObject({ isProspect: true, isCustomer: false });
    const asCustomer = await contactsRoute.POST(await send(rep, "/api/contacts", "POST", { name: "Sneaky Ltd", isCustomer: true, idempotencyKey: key("c") }), noContext);
    expect(asCustomer.status).toBe(403);
    const gst = await contactRoute.PATCH(await send(rep, `/api/contacts/${ids.vets}`, "PATCH", { gstNumber: "123456789" }), params({ contactId: ids.vets }));
    expect(gst.status).toBe(403);
    const archived = await contactRoute.PATCH(await send(rep, `/api/contacts/${ids.vets}`, "PATCH", { isArchived: true }), params({ contactId: ids.vets }));
    expect(archived.status).toBe(403);
    const phone = await contactRoute.PATCH(await send(rep, `/api/contacts/${ids.vets}`, "PATCH", { phone: "03 477 0000" }), params({ contactId: ids.vets }));
    expect(phone.status).toBe(200);
    const note = await notesRoute.POST(
      await send(rep, `/api/records/contact/${ids.vets}/notes`, "POST", { body: "Met at the A&P show", idempotencyKey: key("n") }),
      params({ recordType: "contact", recordId: ids.vets }),
    );
    expect(note.status).toBe(201);
  });

  it("teams: admins make them; a manager sees their team's deals, tasks and forecast", async () => {
    expect((await teamsRoute.POST(await send(rep, "/api/crm/teams", "POST", { name: "Mine", managerUserId: rep.id }), noContext)).status).toBe(403);
    const made = await teamsRoute.POST(await send(owner, "/api/crm/teams", "POST", { name: "South", managerUserId: manager.id, memberUserIds: [rep.id] }), noContext);
    expect(made.status).toBe(201);
    const team = (await bodyOf(made)).team as Json;
    // One team each.
    const second = await teamsRoute.POST(await send(owner, "/api/crm/teams", "POST", { name: "North", managerUserId: owner.id, memberUserIds: [rep.id] }), noContext);
    expect(second.status).toBe(409);
    const names = ((await bodyOf(await opportunitiesRoute.GET(await get(manager, "/api/crm/opportunities"), noContext))).opportunities as Json[]).map((o) => o.name);
    expect(names).toContain("Ruby's deal");
    expect(names).not.toContain("Otto's deal");
    const forecast = (await bodyOf(await forecastsRoute.GET(await get(manager, "/api/crm/forecasts?period=month&from=2026-10-01"), noContext))).forecast as Json;
    const owners = new Set((forecast.rows as Json[]).map((row) => row.ownerUserId));
    expect(owners.has(otherRep.id)).toBe(false);
    expect((await forecastsRoute.GET(await get(rep, `/api/crm/forecasts?ownerUserId=${otherRep.id}`), noContext)).status).toBe(404);
    // Otto joins the team: the manager now sees his deal; removing the team takes it away again.
    await teamRoute.PATCH(await send(owner, `/api/crm/teams/${team.id}`, "PATCH", { memberUserIds: [rep.id, otherRep.id] }), params({ teamId: team.id as string }));
    expect((await opportunityRoute.GET(await get(manager, `/api/crm/opportunities/${ids.otherDeal}`), params({ opportunityId: ids.otherDeal }))).status).toBe(200);
    await teamRoute.DELETE(await get(owner, `/api/crm/teams/${team.id}`), params({ teamId: team.id as string }));
    expect((await opportunityRoute.GET(await get(manager, `/api/crm/opportunities/${ids.otherDeal}`), params({ opportunityId: ids.otherDeal }))).status).toBe(404);
  });

  it("search finds a rep's CRM records only", async () => {
    const result = await bodyOf(await searchRoute.GET(await get(rep, "/api/search?q=deal"), noContext));
    const records = (result.groups as Json[]).flatMap((group) => (group.records as Json[]).map((record) => `${group.key}:${record.title}`));
    expect(records).toContain("crm_opportunity:Ruby's deal");
    expect(records).not.toContain("crm_opportunity:Otto's deal");
    const vets = await bodyOf(await searchRoute.GET(await get(rep, "/api/search?q=Vets"), noContext));
    const keys = (vets.groups as Json[]).map((group) => group.key);
    expect(keys).toContain("crm_company");
    expect(keys).not.toContain("invoice");
    expect(keys).not.toContain("contact");
  });
});
