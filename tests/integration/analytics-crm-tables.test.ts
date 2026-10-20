import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as booksRoute from "@/app/api/analytics/books/route";
import * as analyticsRoute from "@/app/api/analytics/route";
import { closeAnalytics, queryAnalytics } from "@/lib/analytics/engine";
import { tableLabel } from "@/lib/analytics/labels";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { addMembers, createCampaign, setSourceCampaign } from "@/lib/crm/campaigns";
import { setDealLines } from "@/lib/crm/deal-lines";
import { convertLead, createLead, updateLead } from "@/lib/crm/leads";
import { createSequence, enrol, stopEnrolment } from "@/lib/crm/sequences";
import { createOpportunity, createPerson, createTask, updateTask } from "@/lib/crm/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { createItem } from "@/lib/items/service";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { encryptSecret } from "@/lib/secrets";
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

const ORG = "crm-tables-co";
const noContext = undefined as unknown;

/** Example AB11 (decision 652, #216, #360 item 17): the CRM's reporting tables in the analytics copy. */
describeWithDatabase("analytics: the CRM's reporting tables (AB11)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let rep: SessionUser;
  let root: string;
  const savedKey = process.env.TOHYEE_SECRET_KEY;
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const refresh = async () =>
    (await (await booksRoute.POST(apiRequest("/api/analytics/books", { method: "POST", cookie: await sessionCookieFor(owner), body: { organisationId: ORG } }), noContext)).json()) as {
      run?: { status: string; error: string | null };
    };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-crm-tables-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    process.env.TOHYEE_SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    rep = await createTestUser("rep@example.com", { displayName: "Ruby Rep" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'sales_rep')", [ORG, rep.id]);
    await as((tx) => updateOrganisationSettings(tx, { analyticsEnabled: true, crmEnabled: true }));

    const expo = await as((tx) => createCampaign(tx, { name: "Pet expo", kind: "event", status: "active", startDate: "2026-09-01", budget: "800.00", actualCost: "650.50" }));
    const company = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Vets", isProspect: true }))).contact;
    const tama = await as((tx) => createPerson(tx, { contactId: company.id, firstName: "Tama", email: "tama@harbourvets.nz" }));
    const aroha = (await as((tx) => createLead(tx, { idempotencyKey: key("l"), firstName: "Aroha", lastName: "Ngata", email: "aroha@example.nz", phone: "021 555 0101", ownerUserId: rep.id }))).lead;
    await as((tx) => setSourceCampaign(tx, { leadId: aroha.id, campaignId: expo.id }));
    const walkIn = (await as((tx) => createLead(tx, { idempotencyKey: key("l"), lastName: "Walk-in", ownerUserId: rep.id }))).lead;
    await as((tx) => updateLead(tx, walkIn.id, { status: "unqualified", unqualifiedReason: "Just browsing" }));
    await as((tx) => addMembers(tx, { campaignId: expo.id, personIds: [tama.id] }));
    const converted = await as((tx) => convertLead(tx, aroha.id, { opportunityName: "Aroha's keyrings", amount: "100.00", closeDate: "2026-12-01" }));

    const keyring = (
      await as((tx) => createItem(tx, { idempotencyKey: key("i"), code: "KEYRING", name: "Paw print keyring", itemType: "service", salePrice: "25.00", incomeAccountCode: "4000", salesTaxCode: "GST" }))
    ).item;
    const clinic = await as((tx) => createOpportunity(tx, { name: "Clinic keyrings", contactId: company.id, ownerUserId: rep.id, amount: "0" }));
    await as((tx) => setDealLines(tx, clinic.id, { lines: [{ itemId: keyring.id, quantity: "20", discountPercent: "10" }, { description: "Setup", quantity: "1", unitPrice: "50.00" }] }));

    const sequence = await as((tx) => createSequence(tx, { name: "Clinic intro", steps: [{ dayOffset: 0, kind: "call", title: "Call" }, { dayOffset: 30, kind: "task", title: "Samples" }] }));
    const enrolment = await as((tx) => enrol(tx, { sequenceId: sequence.id, personId: tama.id }));
    await as((tx) => stopEnrolment(tx, enrolment.id));

    const task = await as((tx) => createTask(tx, { title: "Send price list", assigneeUserId: rep.id, contactId: company.id, dueDate: "2026-10-01" }));
    await as((tx) => updateTask(tx, task.id, { status: "done" }));

    await as(async (tx) => {
      const account = await tx.query<{ id: string }>(
        `insert into crm_connected_accounts (user_id, provider, email, refresh_token_ciphertext) values ($1, 'google', 'ruby@example.com', $2) returning id::text`,
        [rep.id, encryptSecret("x")],
      );
      await tx.query(
        `insert into crm_sent_emails (command_source, idempotency_key, request_hash, account_id, sent_by_user_id, to_email, subject, body, person_id, status, sent_at)
         values ('ui', 'e1', 'h', $1, $2, 'tama@harbourvets.nz', 'Private subject', 'Private words', $3, 'sent', '2026-10-02T01:00:00Z'),
                ('ui', 'e2', 'h', $1, $2, 'tama@harbourvets.nz', 'Still going', 'Hi', $3, 'sending', null)`,
        [account.rows[0].id, rep.id, tama.id],
      );
    });
    expect(converted.lead.status).toBe("converted");
    expect((await refresh()).run?.status).toBe("ok");
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("leads: status, source, owner, source campaign and when converted, without their email or phone", async () => {
    const leads = await queryAnalytics(ORG, "select name, status, source, owner, source_campaign, converted_on is not null as converted, unqualified_reason from tohyee_crm_leads order by name");
    expect(leads).toEqual([
      { name: "Aroha Ngata", status: "converted", source: "manual", owner: "Ruby Rep", source_campaign: "Pet expo", converted: true, unqualified_reason: null },
      { name: "Walk-in", status: "unqualified", source: "manual", owner: "Ruby Rep", source_campaign: null, converted: false, unqualified_reason: "Just browsing" },
    ]);
    const columns = await queryAnalytics(ORG, "select column_name from information_schema.columns where table_name = 'tohyee_crm_leads'");
    expect(columns.map((row) => row.column_name)).not.toContain("email");
    expect(columns.map((row) => row.column_name)).not.toContain("phone");
    // The deal from Aroha keeps her source campaign (decision 498).
    expect(await queryAnalytics(ORG, "select name, source_campaign from tohyee_crm_opportunities where name = 'Aroha''s keyrings'")).toEqual([
      { name: "Aroha's keyrings", source_campaign: "Pet expo" },
    ]);
  });

  it("campaigns and members, with budget and cost exact", async () => {
    expect(await queryAnalytics(ORG, "select name, kind, status, budget::varchar as budget, actual_cost::varchar as cost from tohyee_crm_campaigns")).toEqual([
      { name: "Pet expo", kind: "event", status: "active", budget: "800.00", cost: "650.50" },
    ]);
    const members = await queryAnalytics(ORG, "select campaign, lead_id is not null as lead, person_id is not null as person, status from tohyee_crm_campaign_members order by lead desc");
    expect(members).toEqual([
      { campaign: "Pet expo", lead: true, person: false, status: "added" },
      { campaign: "Pet expo", lead: false, person: true, status: "added" },
    ]);
  });

  it("sequences, who's in them and how they ended", async () => {
    expect(await queryAnalytics(ORG, "select name, active, steps from tohyee_crm_sequences")).toEqual([{ name: "Clinic intro", active: true, steps: 2 }]);
    expect(await queryAnalytics(ORG, "select sequence, record, status, assigned_to, tasks_made from tohyee_crm_sequence_enrolments")).toEqual([
      { sequence: "Clinic intro", record: "person", status: "stopped", assigned_to: "Jess", tasks_made: 1 },
    ]);
  });

  it("sales emails: sent ones, by whom, with no subject, words or address", async () => {
    expect(await queryAnalytics(ORG, "select sent_on::varchar as sent_on, sent_by, status from tohyee_crm_sales_emails")).toEqual([
      { sent_on: "2026-10-02", sent_by: "Ruby Rep", status: "sent" },
    ]);
    const columns = (await queryAnalytics(ORG, "select column_name from information_schema.columns where table_name = 'tohyee_crm_sales_emails'")).map((row) => row.column_name);
    for (const hidden of ["subject", "body", "to_email"]) expect(columns).not.toContain(hidden);
  });

  it("deal products: DS7's lines, excluding GST, adding to the deal's amount", async () => {
    expect(
      await queryAnalytics(
        ORG,
        "select item_code, description, quantity::varchar as quantity, unit_price::varchar as price, discount_percent::varchar as disc, amount::varchar as amount, currency from tohyee_crm_deal_products order by line_order",
      ),
    ).toEqual([
      { item_code: "KEYRING", description: "Paw print keyring", quantity: "20.0000", price: "25.0000", disc: "10.00", amount: "450.00", currency: "NZD" },
      { item_code: null, description: "Setup", quantity: "1.0000", price: "50.0000", disc: "0.00", amount: "50.00", currency: "NZD" },
    ]);
    expect(
      await queryAnalytics(ORG, "select o.amount::varchar as deal, sum(p.amount)::varchar as lines from tohyee_crm_deal_products p join tohyee_crm_opportunities o using (opportunity_id) group by o.amount"),
    ).toEqual([{ deal: "500.00", lines: "500.00" }]);
  });

  it("tasks, and the friendly names", async () => {
    expect(await queryAnalytics(ORG, "select title, status, assigned_to, company, done_on is not null as done from tohyee_crm_tasks where title = 'Send price list'")).toEqual([
      { title: "Send price list", status: "done", assigned_to: "Ruby Rep", company: "Harbour Vets", done: true },
    ]);
    expect(tableLabel("tohyee_crm_deal_products")).toBe("CRM deal products");
    expect(tableLabel("tohyee_crm_sequence_enrolments")).toBe("CRM sequence enrolments");
  });

  it("sales roles still can't reach Analytics; with Accounting off the CRM tables stay", async () => {
    const asRep = await analyticsRoute.GET(apiRequest(`/api/analytics?organisationId=${ORG}`, { cookie: await sessionCookieFor(rep) }), noContext);
    expect(asRep.status).toBe(403);
    await as((tx) => updateOrganisationSettings(tx, { accountingEnabled: false }));
    expect((await refresh()).run?.status).toBe("ok");
    const names = (await queryAnalytics(ORG, "select table_name from information_schema.tables where table_name like 'tohyee_%' order by table_name")).map((row) => row.table_name);
    expect(names).toEqual([
      "tohyee_crm_activities",
      "tohyee_crm_campaign_members",
      "tohyee_crm_campaigns",
      "tohyee_crm_companies",
      "tohyee_crm_deal_products",
      "tohyee_crm_leads",
      "tohyee_crm_opportunities",
      "tohyee_crm_sales_emails",
      "tohyee_crm_sequence_enrolments",
      "tohyee_crm_sequences",
      "tohyee_crm_tasks",
    ]);
    await as((tx) => updateOrganisationSettings(tx, { accountingEnabled: true }));
  });
});
