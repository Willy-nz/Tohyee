import { afterAll, beforeAll, expect, it } from "vitest";
import * as leadRoute from "@/app/api/crm/leads/[leadId]/route";
import * as leadsRoute from "@/app/api/crm/leads/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { getContact, createContact } from "@/lib/contacts/service";
import { crmScope, type CrmScope } from "@/lib/crm/access";
import { convertLead, createLead, getLead, importLeads, listLeads, updateLead } from "@/lib/crm/leads";
import { createActivity, createPerson, createTask, getOpportunity, listActivities, listTasks } from "@/lib/crm/service";
import { createSalesTeam } from "@/lib/crm/teams";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
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

const ORG = "crm-leads";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;
const b64 = (text: string) => Buffer.from(text).toString("base64");

/** Decision 492 (#216): leads typed in and imported, worked, unqualified or converted, and who sees them. */
describeWithDatabase("CRM leads (decision 492)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let rep: SessionUser;
  let otherRep: SessionUser;
  let manager: SessionUser;

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const scoped = async <T>(user: SessionUser, role: "owner" | "sales_rep" | "sales_manager", work: (tx: OrgTx, scope: CrmScope) => Promise<T>) =>
    as(user, async (tx) => work(tx, await crmScope(tx, role, user.id)));

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    rep = await createTestUser("rep@example.com", { displayName: "Ruby Rep" });
    otherRep = await createTestUser("other@example.com", { displayName: "Otto Rep" });
    manager = await createTestUser("manager@example.com", { displayName: "Mere Manager" });
    await coreQuery(
      "insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'sales_rep'), ($1, $3, 'sales_rep'), ($1, $4, 'sales_manager')",
      [ORG, rep.id, otherRep.id, manager.id],
    );
    await as(owner, (tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    await as(owner, (tx) => createSalesTeam(tx, { name: "South", managerUserId: manager.id, memberUserIds: [rep.id] }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("a lead typed in is its adder's; a retry with the same key returns it; it needs a name, company or email", async () => {
    const lead = { firstName: "Aroha", lastName: "Ngata", companyName: "Mānuka Vets", email: "aroha@manukavets.nz", idempotencyKey: "lead-aroha-1" };
    const made = await scoped(rep, "sales_rep", (tx, scope) => createLead(tx, lead, scope));
    expect(made.created).toBe(true);
    expect(made.lead).toMatchObject({ name: "Aroha Ngata", status: "new", source: "manual", ownerUserId: rep.id, needsReview: false });
    expect((await scoped(rep, "sales_rep", (tx, scope) => createLead(tx, lead, scope))).created).toBe(false);
    await expect(scoped(rep, "sales_rep", (tx, scope) => createLead(tx, { idempotencyKey: key("l"), phone: "021 000 000" }, scope))).rejects.toThrow(
      "A lead needs at least a name, a company or an email.",
    );
    await expect(scoped(rep, "sales_rep", (tx, scope) => createLead(tx, { idempotencyKey: key("l"), email: "not-an-email" }, scope))).rejects.toThrow(/valid email/);
    // A rep can't hand a lead to someone else.
    await expect(scoped(rep, "sales_rep", (tx, scope) => createLead(tx, { idempotencyKey: key("l"), lastName: "X", ownerUserId: otherRep.id }, scope))).rejects.toThrow(
      /only own their own/,
    );
  });

  it("who sees which lead: the owner, their manager, and unassigned ones for managers and viewers and up", async () => {
    const ottos = (await scoped(otherRep, "sales_rep", (tx, scope) => createLead(tx, { idempotencyKey: key("l"), lastName: "Otto's lead" }, scope))).lead;
    await as(owner, (tx) => createLead(tx, { idempotencyKey: key("l"), companyName: "Walk-in Ltd", ownerUserId: null }));
    const names = async (user: SessionUser, role: "owner" | "sales_rep" | "sales_manager") =>
      (await scoped(user, role, (tx, scope) => listLeads(tx, { scope: role === "owner" ? undefined : scope }))).map((lead) => lead.name);
    expect(await names(rep, "sales_rep")).not.toContain("Otto's lead");
    expect(await names(rep, "sales_rep")).not.toContain("Walk-in Ltd");
    expect(await names(manager, "sales_manager")).toEqual(expect.arrayContaining(["Aroha Ngata", "Walk-in Ltd"]));
    expect(await names(manager, "sales_manager")).not.toContain("Otto's lead");
    expect(await names(owner, "owner")).toEqual(expect.arrayContaining(["Aroha Ngata", "Walk-in Ltd", "Otto's lead"]));
    await expect(scoped(rep, "sales_rep", (tx, scope) => getLead(tx, ottos.id, scope))).rejects.toThrow("Lead not found.");
    // Through the routes too.
    const response = await leadRoute.GET(apiRequest(`/api/crm/leads/${ottos.id}?organisationId=${ORG}`, { cookie: await sessionCookieFor(rep) }), params({ leadId: ottos.id }));
    expect(response.status).toBe(404);
    const list = await leadsRoute.GET(apiRequest(`/api/crm/leads?organisationId=${ORG}&status=open`, { cookie: await sessionCookieFor(manager) }), noContext);
    expect(((await list.json()) as { leads: Json[] }).leads.map((lead) => lead.name)).toContain("Walk-in Ltd");
  });

  it("working, unqualified with a reason, and back", async () => {
    const lead = (await scoped(rep, "sales_rep", (tx, scope) => createLead(tx, { idempotencyKey: key("l"), lastName: "Maybe", companyName: "Maybe Ltd" }, scope))).lead;
    expect((await scoped(rep, "sales_rep", (tx, scope) => updateLead(tx, lead.id, { status: "working" }, scope))).status).toBe("working");
    await expect(scoped(rep, "sales_rep", (tx, scope) => updateLead(tx, lead.id, { status: "unqualified" }, scope))).rejects.toThrow(/Say why/);
    const unqualified = await scoped(rep, "sales_rep", (tx, scope) => updateLead(tx, lead.id, { status: "unqualified", unqualifiedReason: "No budget" }, scope));
    expect(unqualified).toMatchObject({ status: "unqualified", unqualifiedReason: "No budget" });
    await expect(scoped(rep, "sales_rep", (tx, scope) => convertLead(tx, lead.id, {}, scope))).rejects.toThrow(/unqualified/);
    expect(await scoped(rep, "sales_rep", (tx, scope) => updateLead(tx, lead.id, { status: "working" }, scope))).toMatchObject({ status: "working", unqualifiedReason: null });
  });

  it("converting makes a prospect company, a person and an opportunity, and keeps the lead's history", async () => {
    const lead = (
      await scoped(rep, "sales_rep", (tx, scope) =>
        createLead(tx, { idempotencyKey: key("l"), firstName: "Tama", lastName: "Paki", companyName: "Kea Pets", email: "tama@keapets.nz", phone: "03 477 1234", jobTitle: "Owner" }, scope),
      )
    ).lead;
    const call = await scoped(rep, "sales_rep", (tx, scope) => createActivity(tx, { kind: "call", subject: "First call", leadId: lead.id }, scope));
    const task = await scoped(rep, "sales_rep", (tx, scope) => createTask(tx, { title: "Send prices", leadId: lead.id }, scope));
    expect(call.leadId).toBe(lead.id);
    expect(task.assigneeUserId).toBe(rep.id);
    const done = await scoped(rep, "sales_rep", (tx, scope) => convertLead(tx, lead.id, { opportunityName: "Kea Pets: memorial range", amount: "2400.00", closeDate: "2026-11-30" }, scope));
    expect(done.created).toBe(true);
    expect(done.lead).toMatchObject({ status: "converted", needsReview: false });
    const company = await as(owner, (tx) => getContact(tx, done.lead.convertedContactId!));
    expect(company).toMatchObject({ name: "Kea Pets", isProspect: true, isCustomer: false, ownerUserId: rep.id });
    const deal = await as(owner, (tx) => getOpportunity(tx, done.lead.convertedOpportunityId!));
    expect(deal).toMatchObject({ name: "Kea Pets: memorial range", amount: "2400.00", ownerUserId: rep.id, pointOfContactId: done.lead.convertedPersonId });
    // The call and the task are now the company's and the person's too.
    const companyActivities = await as(owner, (tx) => listActivities(tx, { contactId: company.id }));
    expect(companyActivities.map((activity) => activity.subject)).toContain("First call");
    const personTasks = await as(owner, (tx) => listTasks(tx, { personId: done.lead.convertedPersonId }));
    expect(personTasks.map((entry) => entry.title)).toEqual(["Send prices"]);
    // Again: the same result; and a converted lead doesn't change.
    expect((await scoped(rep, "sales_rep", (tx, scope) => convertLead(tx, lead.id, {}, scope))).created).toBe(false);
    await expect(scoped(rep, "sales_rep", (tx, scope) => updateLead(tx, lead.id, { phone: "1" }, scope))).rejects.toThrow(/has been converted/);
  });

  it("converting into an existing company, without an opportunity; a person at another company is refused", async () => {
    const vets = (await as(owner, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Southern Vets", isCustomer: true }))).contact;
    const elsewhere = (await as(owner, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Elsewhere Ltd", isProspect: true }))).contact;
    const stranger = await as(owner, (tx) => createPerson(tx, { contactId: elsewhere.id, firstName: "Sam" }));
    const lead = (await as(owner, (tx) => createLead(tx, { idempotencyKey: key("l"), firstName: "Mere", email: "mere@southernvets.nz" }))).lead;
    await expect(as(owner, (tx) => convertLead(tx, lead.id, { contactId: vets.id, personId: stranger.id }))).rejects.toThrow(/doesn't work at that company/);
    const done = await as(owner, (tx) => convertLead(tx, lead.id, { contactId: vets.id, opportunity: false }));
    expect(done.lead).toMatchObject({ convertedContactId: vets.id, convertedOpportunityId: null });
  });

  it("imports leads from a spreadsheet, skipping open duplicates and bad rows; the same file again adds nothing", async () => {
    const csv = [
      "Name,Company,E-mail,Mobile,Title,Lead source,Notes",
      "Hemi Walker,Tūī Kennels,hemi@tui.nz,021 111 222,Manager,A&P show,Wants a quote",
      "Kiri Smith,,kiri@example.nz,,,,",
      "Bad Email,Nope Ltd,not-an-email,,,,",
      "Aroha Again,Mānuka Vets,AROHA@manukavets.nz,,,,",
      ",,,,,,",
    ].join("\n");
    const run = () => scoped(rep, "sales_rep", (tx, scope) => importLeads(tx, { fileName: "show.csv", fileBase64: b64(csv), idempotencyKey: "import-show-1" }, scope));
    const result = await run();
    expect(result.created).toBe(2);
    expect(result.skipped).toEqual([
      { row: 4, reason: expect.stringMatching(/valid email/) },
      { row: 5, reason: "AROHA@manukavets.nz is already an open lead." },
    ]);
    expect(result.leads[0]).toMatchObject({
      firstName: "Hemi",
      lastName: "Walker",
      companyName: "Tūī Kennels",
      phone: "021 111 222",
      jobTitle: "Manager",
      sourceDetail: "A&P show",
      description: "Wants a quote",
      source: "import",
      ownerUserId: rep.id,
    });
    const again = await run();
    expect(again.created).toBe(0);
    expect(again.skipped.filter((skip) => skip.reason === "Already imported.")).toHaveLength(2);
    await expect(scoped(rep, "sales_rep", (tx, scope) => importLeads(tx, { fileName: "x.csv", fileBase64: b64("Colour,Size\nred,big"), idempotencyKey: key("i") }, scope))).rejects.toThrow(
      /headings/,
    );
  });
});
