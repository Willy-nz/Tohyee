import { afterAll, beforeAll, expect, it } from "vitest";
import * as companyRoute from "@/app/api/crm/companies/[contactId]/route";
import * as peopleRoute from "@/app/api/crm/people/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact, getContact, updateContact } from "@/lib/contacts/service";
import {
  companyTimeline,
  createActivity,
  createOpportunity,
  createPerson,
  createTask,
  listCompanies,
  listOpportunities,
  makeInvoiceFromOpportunity,
  updateOpportunity,
  updatePerson,
  updateTask,
} from "@/lib/crm/service";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createTaxCode } from "@/lib/tax/codes";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const noContext = undefined as unknown;

/** Examples MOD1 and CRM1-CRM9 in docs/ACCOUNTING-EXAMPLES.md ("Modules and the CRM"). Each test gets its own organisation. */
describeWithDatabase("modules and the CRM", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jess@example.com", { serverAdmin: true, displayName: "Jess" });
    viewer = await createTestUser("viewer@example.com");
    outsider = await createTestUser("outsider@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(options: { crm?: boolean } = {}) {
    organisations += 1;
    const org = `crm-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "GST", label: "GST (15%)", category: "standard", rate: "0.15", effectiveFrom: "2026-01-01" }),
    );
    if (options.crm !== false) await as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    return { org, as };
  }

  async function withVets() {
    const w = await setup();
    const vets = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Mānuka Vets", isProspect: true }))).contact;
    const aroha = await w.as((tx) =>
      createPerson(tx, { contactId: vets.id, firstName: "Aroha", lastName: "Ngata", jobTitle: "Practice manager", email: "aroha@manukavets.nz" }),
    );
    const deal = await w.as((tx) =>
      createOpportunity(tx, {
        name: "Memorial paw prints 2027",
        contactId: vets.id,
        pointOfContactId: aroha.id,
        ownerUserId: owner.id,
        amount: "2400",
        closeDate: "2026-12-15",
      }),
    );
    return { ...w, vets, aroha, deal };
  }

  it("MOD1: the CRM and Advanced reporting start off; switching is recorded; commands are refused while off", async () => {
    const w = await setup({ crm: false });
    const settings = await w.as((tx) => tx.query<{ crm_enabled: boolean; advanced_features: boolean }>("select crm_enabled, advanced_features from organisation_settings"));
    expect(settings.rows[0]).toEqual({ crm_enabled: false, advanced_features: false });
    await expect(w.as((tx) => createPerson(tx, { firstName: "Aroha" }))).rejects.toThrow("The CRM is off");
    await w.as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    const person = await w.as((tx) => createPerson(tx, { firstName: "Aroha" }));
    await w.as((tx) => updateOrganisationSettings(tx, { crmEnabled: false }));
    await expect(w.as((tx) => updatePerson(tx, person.id, { jobTitle: "Manager" }))).rejects.toThrow("The CRM is off");
    const history = await w.as((tx) =>
      tx.query<{ details: { crmEnabled: boolean } }>("select details from audit_events where event_type = 'organisation.settings_updated' order by id"),
    );
    expect(history.rows.map((row) => row.details.crmEnabled)).toEqual([true, false]);
  });

  it("CRM1: prospects", async () => {
    const w = await setup();
    const vets = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Mānuka Vets", isProspect: true }))).contact;
    expect([vets.isProspect, vets.isCustomer, vets.isSupplier]).toEqual([true, false, false]);
    await expect(
      w.as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("i"),
          contactId: vets.id,
          invoiceDate: "2026-09-01",
          dueDate: "2026-09-20",
          amountsMode: "exclusive",
          lines: [{ description: "Kit", quantity: "1", unitPrice: "10", accountCode: "4000", taxCode: "GST" }],
        }),
      ),
    ).rejects.toThrow("isn't marked as a customer");
    await expect(w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Nobody" }))).rejects.toThrow(
      "A contact must be a customer, a supplier or a prospect.",
    );
    await w.as((tx) => updateOrganisationSettings(tx, { crmEnabled: false }));
    await expect(w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Rata", isProspect: true }))).rejects.toThrow(
      "The CRM is off, so a contact can't be made a prospect.",
    );
    // One that already is stays one.
    expect((await w.as((tx) => updateContact(tx, vets.id, { phone: "03 477 0000" }))).isProspect).toBe(true);
  });

  it("CRM2: people", async () => {
    const { as, vets, aroha } = await withVets();
    expect([aroha.fullName, aroha.jobTitle, aroha.email, aroha.contactName]).toEqual(["Aroha Ngata", "Practice manager", "aroha@manukavets.nz", "Mānuka Vets"]);
    await expect(as((tx) => createPerson(tx, { contactId: "999999", firstName: "Ben" }))).rejects.toThrow("There's no contact #999999.");
    await expect(as((tx) => createPerson(tx, { contactId: vets.id, firstName: "Ben", email: "not an email" }))).rejects.toThrow("valid email");
    await expect(as((tx) => tx.query("delete from crm_people where id = $1", [aroha.id]))).rejects.toThrow(/can't be deleted/);
    expect((await as((tx) => updatePerson(tx, aroha.id, { isArchived: true }))).isArchived).toBe(true);
  });

  it("CRM3: opportunities", async () => {
    const { as, vets, deal } = await withVets();
    expect([deal.name, deal.contactName, deal.pointOfContactName, deal.ownerUserId, deal.amount, deal.closeDate, deal.stage]).toEqual([
      "Memorial paw prints 2027",
      "Mānuka Vets",
      "Aroha Ngata",
      owner.id,
      "2400.00",
      "2026-12-15",
      "new",
    ]);
    const other = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Rata Ltd", isCustomer: true }))).contact;
    const ben = await as((tx) => createPerson(tx, { contactId: other.id, firstName: "Ben" }));
    await expect(as((tx) => createOpportunity(tx, { name: "X", contactId: vets.id, pointOfContactId: ben.id }))).rejects.toThrow(
      "Ben doesn't work at that company.",
    );
    await expect(as((tx) => createOpportunity(tx, { name: "X", contactId: vets.id, amount: "-5" }))).rejects.toThrow("can't be negative");
    await expect(as((tx) => createOpportunity(tx, { name: "X", contactId: vets.id, ownerUserId: outsider.id }))).rejects.toThrow(
      "The owner must be a member of the organisation.",
    );
  });

  it("CRM4: stage changes are in the history and the timeline", async () => {
    const { as, vets, deal } = await withVets();
    for (const stage of ["proposal", "lost", "proposal"]) await as((tx) => updateOpportunity(tx, deal.id, { stage }));
    const timeline = await as((tx) => companyTimeline(tx, vets.id));
    expect(timeline.filter((e) => e.kind === "opportunity_stage").map((e) => e.title)).toEqual([
      "Opportunity Memorial paw prints 2027: Lost → Proposal",
      "Opportunity Memorial paw prints 2027: Proposal → Lost",
      "Opportunity Memorial paw prints 2027: New → Proposal",
    ]);
  });

  it("CRM5: a won opportunity makes a draft invoice", async () => {
    const { as, vets, deal } = await withVets();
    await expect(as((tx) => makeInvoiceFromOpportunity(tx, deal.id))).rejects.toThrow("Only a won opportunity can make an invoice.");
    await as((tx) => updateOpportunity(tx, deal.id, { stage: "won" }));
    const { created, invoice } = await as((tx) => makeInvoiceFromOpportunity(tx, deal.id));
    expect(created).toBe(true);
    expect([invoice.status, invoice.contactId, invoice.invoiceDate, invoice.total, invoice.approvalJournalId]).toEqual([
      "draft",
      vets.id,
      todayIsoDate(),
      "2760.00",
      null,
    ]);
    expect(invoice.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.accountCode, l.taxCode])).toEqual([
      ["Memorial paw prints 2027", "1", "2400", "4000", "GST"],
    ]);
    const contact = await as((tx) => getContact(tx, vets.id));
    expect([contact.isCustomer, contact.isProspect]).toEqual([true, true]);
    const again = await as((tx) => makeInvoiceFromOpportunity(tx, deal.id));
    expect([again.created, again.invoice.id]).toEqual([false, invoice.id]);
    await expect(as((tx) => updateOpportunity(tx, deal.id, { stage: "lost" }))).rejects.toThrow("has made an invoice");
    const journals = await as((tx) => tx.query("select id from ledger_journals"));
    expect(journals.rowCount).toBe(0);
  });

  it("CRM6: tasks", async () => {
    const { as, deal } = await withVets();
    const task = await as((tx) => createTask(tx, { title: "Send sample kit", dueDate: "2026-10-01", assigneeUserId: owner.id, opportunityId: deal.id }));
    expect([task.status, task.opportunityName, task.completedAt]).toEqual(["todo", "Memorial paw prints 2027", null]);
    const done = await as((tx) => updateTask(tx, task.id, { status: "done" }));
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    await expect(as((tx) => createTask(tx, { title: "X", assigneeUserId: outsider.id }))).rejects.toThrow("The assignee must be a member");
    await expect(as((tx) => tx.query("delete from crm_tasks where id = $1", [task.id]))).rejects.toThrow(/can't be deleted/);
  });

  it("CRM7: activities", async () => {
    const { as, vets, aroha } = await withVets();
    const call = await as((tx) =>
      createActivity(tx, { kind: "call", happenedAt: "2026-09-28T10:00:00+13:00", subject: "Talked about pricing", personId: aroha.id }),
    );
    expect([call.kind, call.happenedAt, call.personName]).toEqual(["call", "2026-09-27T21:00:00.000Z", "Aroha Ngata"]);
    await as((tx) => createActivity(tx, { kind: "meeting", happenedAt: "2026-09-29T09:00:00+13:00", subject: "Clinic visit", contactId: vets.id }));
    await as((tx) => createActivity(tx, { kind: "note", subject: "Prefers email", contactId: vets.id }));
    await expect(as((tx) => createActivity(tx, { kind: "note", subject: "About nothing" }))).rejects.toThrow("must be about a company");
  });

  it("CRM8: the company timeline and list", async () => {
    const { as, vets, aroha, deal } = await withVets();
    await as((tx) => updateOpportunity(tx, deal.id, { stage: "won" }));
    const { invoice } = await as((tx) => makeInvoiceFromOpportunity(tx, deal.id));
    await as((tx) => createTask(tx, { title: "Send sample kit", opportunityId: deal.id }));
    await as((tx) => createActivity(tx, { kind: "call", happenedAt: "2026-01-02T10:00:00Z", subject: "First call", personId: aroha.id }));
    await as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }));
    const timeline = await as((tx) => companyTimeline(tx, vets.id));
    expect(timeline[0]).toMatchObject({ kind: "invoice", amount: "2760.00", href: `/operations/invoices/${invoice.id}` });
    expect(timeline.map((e) => e.kind)).toEqual(expect.arrayContaining(["invoice", "task", "opportunity_created", "opportunity_stage", "activity"]));
    expect(timeline.at(-1)).toMatchObject({ kind: "activity", title: "Call: First call" });
    const company = (await as((tx) => listCompanies(tx))).find((c) => c.contactId === vets.id)!;
    expect([company.people, company.openTasks, company.openPipeline]).toEqual([1, 1, "0.00"]);
  });

  it("CRM9: the pipeline in stage order with amounts", async () => {
    const { as, vets, deal } = await withVets();
    await as((tx) => createOpportunity(tx, { name: "Clinic display", contactId: vets.id, amount: "600", stage: "proposal" }));
    await as((tx) => createOpportunity(tx, { name: "Staff gifts", contactId: vets.id, amount: "150.50", stage: "new" }));
    const list = await as((tx) => listOpportunities(tx));
    expect(list.map((o) => [o.stage, o.name])).toEqual([
      ["new", deal.name],
      ["new", "Staff gifts"],
      ["proposal", "Clinic display"],
    ]);
    const company = (await as((tx) => listCompanies(tx))).find((c) => c.contactId === vets.id)!;
    expect(company.openPipeline).toBe("3150.50");
  });

  it("over HTTP: viewers read; only bookkeepers and up write", async () => {
    const { org, vets } = await withVets();
    const viewerCookie = await sessionCookieFor(viewer);
    const read = await companyRoute.GET(apiRequest(`/api/crm/companies/${vets.id}?organisationId=${org}`, { cookie: viewerCookie }), {
      params: Promise.resolve({ contactId: vets.id }),
    });
    expect(read.status).toBe(200);
    const body = (await read.json()) as { people: unknown[]; opportunities: unknown[] };
    expect([body.people.length, body.opportunities.length]).toEqual([1, 1]);
    const post = await peopleRoute.POST(
      apiRequest("/api/crm/people", { method: "POST", cookie: viewerCookie, body: { organisationId: org, firstName: "Ben" } }),
      noContext,
    );
    expect(post.status).toBe(403);
  });
});
