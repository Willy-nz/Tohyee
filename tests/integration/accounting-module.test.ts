import { afterAll, beforeAll, expect, it } from "vitest";
import * as adminOrganisationsRoute from "@/app/api/admin/organisations/route";
import { readBooks } from "@/lib/analytics/books";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { createOpportunity, makeInvoiceFromOpportunity, makeSalesOrderFromOpportunity, updateOpportunity } from "@/lib/crm/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { listTopBarNotices } from "@/lib/notices/top-bar";
import { getOrganisation } from "@/lib/organisations/registry";
import { getOrganisationSettings, updateOrganisationSettings } from "@/lib/organisations/settings";
import { runOrganisationRepeatingInvoices } from "@/lib/repeating/scheduler";
import { createRepeatingInvoice, getRepeatingInvoice } from "@/lib/repeating/service";
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

/**
 * Examples MOD2-MOD7 in docs/ACCOUNTING-EXAMPLES.md ("Turning Accounting
 * and Tax off", #181, approved by Jess 8 Oct 2026): a server admin creates
 * Kobe Leads with only the CRM and Kobe Numbers with only Analytics.
 */
describeWithDatabase("turning Accounting off (#181, MOD2-MOD7)", () => {
  let server: TestServer;
  let admin: SessionUser;
  const noContext = { params: Promise.resolve({}) };
  const as = <T>(org: string, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: admin.id, email: admin.email }, work);

  beforeAll(async () => {
    server = await startTestServer();
    admin = await createTestUser("modules-admin@example.com", { serverAdmin: true });
  });
  afterAll(async () => {
    await server?.teardown();
  });

  const create = async (id: string, displayName: string, modules: unknown) =>
    adminOrganisationsRoute.POST(
      apiRequest("/api/admin/organisations", { method: "POST", cookie: await sessionCookieFor(admin), body: { id, displayName, modules } }),
      noContext,
    );

  it("MOD2-MOD4: modules are chosen when an organisation is created; at least one app is needed", async () => {
    const none = await create("kobe-none", "Kobe None", { accounting: false, crm: false, analytics: false });
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: string }).error).toBe("Keep at least one of Accounting, CRM or Analytics on.");

    expect((await create("kobe-leads", "Kobe Leads", { accounting: false, crm: true })).status).toBe(201);
    expect(await as("kobe-leads", (tx) => getOrganisationSettings(tx))).toMatchObject({ accountingEnabled: false, crmEnabled: true, analyticsEnabled: false });
    expect((await create("kobe-numbers", "Kobe Numbers", { accounting: false, analytics: true })).status).toBe(201);
    expect(await as("kobe-numbers", (tx) => getOrganisationSettings(tx))).toMatchObject({ accountingEnabled: false, crmEnabled: false, analyticsEnabled: true });
    // Tax is the GST registration switch (#180).
    expect((await create("kobe-books", "Kobe Books", { gstRegistered: false })).status).toBe(201);
    expect(await as("kobe-books", (tx) => getOrganisationSettings(tx))).toMatchObject({ accountingEnabled: true, gstRegistered: false });
  });

  it("MOD3: in Kobe Leads the CRM works, but making an invoice or sales order is refused; companies are still contacts", async () => {
    const company = (await as("kobe-leads", (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Mānuka Vets", isProspect: true }))).contact;
    const deal = await as("kobe-leads", (tx) => createOpportunity(tx, { name: "Paw prints", contactId: company.id, ownerUserId: admin.id, amount: "2400" }));
    await as("kobe-leads", (tx) => updateOpportunity(tx, deal.id, { stage: "won" }));
    await expect(as("kobe-leads", (tx) => makeInvoiceFromOpportunity(tx, deal.id))).rejects.toThrow("Accounting is off");
    await expect(as("kobe-leads", (tx) => makeSalesOrderFromOpportunity(tx, deal.id))).rejects.toThrow("Accounting is off");
    // MOD6 (notices): Accounting's top-bar notices aren't shown.
    expect(await as("kobe-leads", (tx) => listTopBarNotices(tx))).toEqual([]);
    // Turning Accounting on later: the company is a contact, and the invoice can be made.
    await as("kobe-leads", (tx) => updateOrganisationSettings(tx, { accountingEnabled: true }));
    const { invoice } = await as("kobe-leads", (tx) => makeInvoiceFromOpportunity(tx, deal.id));
    expect(invoice.contactId).toBe(company.id);
  });

  it("MOD4: the books copy for Kobe Numbers has no ledger, invoice, contact or item tables", async () => {
    const tables = await as("kobe-numbers", (tx) => readBooks(tx));
    expect(tables.map((table) => table.name)).toEqual([]);
    const books = await as("kobe-books", (tx) => readBooks(tx));
    expect(books.map((table) => table.name)).toContain("tohyee_ledger_lines");
  });

  it("MOD5: the last app can't be turned off; Advanced reporting and Not-for-profit need Accounting and go off with it", async () => {
    await expect(as("kobe-numbers", (tx) => updateOrganisationSettings(tx, { analyticsEnabled: false }))).rejects.toThrow(
      "Keep at least one of Accounting, CRM or Analytics on.",
    );
    await expect(as("kobe-numbers", (tx) => updateOrganisationSettings(tx, { advancedFeatures: true }))).rejects.toThrow(
      "Advanced reporting and Not-for-profit need Accounting. Turn Accounting on first.",
    );
    await as("kobe-books", (tx) => updateOrganisationSettings(tx, { advancedFeatures: true, notForProfitEnabled: true, crmEnabled: true }));
    await expect(as("kobe-books", (tx) => updateOrganisationSettings(tx, { accountingEnabled: false, crmEnabled: false }))).rejects.toThrow(
      "Keep at least one of Accounting, CRM or Analytics on.",
    );
    const off = await as("kobe-books", (tx) => updateOrganisationSettings(tx, { accountingEnabled: false }));
    expect(off).toMatchObject({ accountingEnabled: false, advancedFeatures: false, notForProfitEnabled: false, crmEnabled: true });
    // The database refuses it too.
    await expect(as("kobe-books", (tx) => tx.query("update organisation_settings set crm_enabled = false where id = true"))).rejects.toThrow(
      /organisation_settings_one_app_on/,
    );
  });

  it("MOD6: repeating invoices pause while Accounting is off and catch up when it's back on", async () => {
    await as("kobe-books", (tx) => updateOrganisationSettings(tx, { accountingEnabled: true }));
    const customer = (await as("kobe-books", (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Cafe", isCustomer: true }))).contact;
    const { repeatingInvoice } = await as("kobe-books", (tx) =>
      createRepeatingInvoice(tx, {
        idempotencyKey: key("ri"),
        contactId: customer.id,
        amountsMode: "no_tax",
        lines: [{ description: "Retainer", quantity: "1", unitPrice: "100.00", accountCode: "4000" }],
        period: "month",
        every: 1,
        startDate: "2026-08-31",
        dueRule: "days_after",
        dueDays: 20,
        saveAs: "draft",
      }),
    );
    await as("kobe-books", (tx) => updateOrganisationSettings(tx, { accountingEnabled: false }));
    const organisation = (await getOrganisation("kobe-books"))!;
    expect(await runOrganisationRepeatingInvoices(organisation, "2026-09-30")).toEqual({ made: 0, failed: 0 });
    await as("kobe-books", (tx) => updateOrganisationSettings(tx, { accountingEnabled: true }));
    expect(await runOrganisationRepeatingInvoices(organisation, "2026-09-30")).toEqual({ made: 2, failed: 0 });
    expect((await as("kobe-books", (tx) => getRepeatingInvoice(tx, repeatingInvoice.id))).runs.map((run) => run.scheduledDate)).toEqual([
      "2026-09-30",
      "2026-08-31",
    ]);
  });

  it("MOD7: existing organisations keep Accounting on", async () => {
    await createTestOrganisation(admin, "kobe-existing");
    expect(await as("kobe-existing", (tx) => getOrganisationSettings(tx))).toMatchObject({ accountingEnabled: true });
  });
});
