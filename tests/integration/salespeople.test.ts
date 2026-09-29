import { afterAll, beforeAll, expect, it } from "vitest";
import * as reportRoute from "@/app/api/reports/sales-by-salesperson/route";
import * as salespeopleRoute from "@/app/api/salespeople/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact, updateContact } from "@/lib/contacts/service";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice, getInvoice, updateInvoice, voidInvoice } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { profitAndLoss } from "@/lib/reports/financial";
import { type SalesBySalesperson, salesBySalesperson } from "@/lib/reports/sales-by-salesperson";
import { createSalesperson, updateSalesperson } from "@/lib/salespeople/service";
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

/** Examples SR1-SR8 in docs/ACCOUNTING-EXAMPLES.md ("Salespeople"). Each test gets its own organisation. */
describeWithDatabase("salespeople", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `sales-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "GST", label: "GST (15%)", category: "standard", rate: "0.15", effectiveFrom: "2026-01-01" }),
    );
    await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    await as((tx) => createSalesperson(tx, { name: "Aroha", email: "aroha@example.co.nz" }));
    const people = (await as((tx) => createSalesperson(tx, { name: "Ben" }))).salespeople;
    const aroha = people.find((p) => p.name === "Aroha")!.id;
    const ben = people.find((p) => p.name === "Ben")!.id;
    const kobe = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Ltd", isCustomer: true, defaultSalespersonId: aroha }))).contact;
    const rata = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Rata Ltd", isCustomer: true }))).contact;
    const line = (amount: string) => ({ description: "Item", quantity: "1", unitPrice: amount, accountCode: "4000", taxCode: "GST" });
    const invoice = async (contactId: string, amount: string, extra: Record<string, unknown> = {}, date = "2026-06-10") =>
      (
        await as((tx) =>
          createInvoice(tx, {
            idempotencyKey: key("invoice"),
            contactId,
            invoiceDate: date,
            dueDate: "2026-07-31",
            amountsMode: "exclusive",
            lines: [line(amount)],
            ...extra,
          }),
        )
      ).invoice;
    const approve = async (id: string) => (await as((tx) => approveInvoice(tx, id, { idempotencyKey: key("approve") }))).invoice;
    return { org, as, aroha, ben, kobe, rata, line, invoice, approve };
  }

  const row = (report: SalesBySalesperson, name: string) => {
    const found = report.rows.find((r) => r.name === name)!;
    return [found.invoices, found.sales, found.creditNotes, found.netSales];
  };

  it("SR1: defaults from the customer; names are unique; never deleted", async () => {
    const w = await setup();
    expect((await w.invoice(w.kobe.id, "10.00")).salespersonId).toBe(w.aroha);
    const withBen = await w.invoice(w.kobe.id, "10.00", { salespersonId: w.ben });
    expect([withBen.salespersonId, withBen.salespersonName]).toEqual([w.ben, "Ben"]);
    expect((await w.invoice(w.rata.id, "10.00")).salespersonId).toBeNull();
    expect((await w.invoice(w.kobe.id, "10.00", { salespersonId: null })).salespersonId).toBeNull();
    await expect(w.as((tx) => createSalesperson(tx, { name: "aroha" }))).rejects.toThrow("There's already a salesperson called aroha.");
    await expect(w.as((tx) => tx.query("delete from salespeople where id = $1", [w.aroha]))).rejects.toThrow(/archive them instead/);
  });

  it("SR2: the salesperson doesn't change the posting, and is fixed once approved", async () => {
    const w = await setup();
    const approved = await w.approve((await w.invoice(w.kobe.id, "100.00")).id);
    expect(approved.salespersonId).toBe(w.aroha);
    const journal = await w.as((tx) => getJournal(tx, approved.approvalJournalId!));
    expect(journal.lines.map((l) => [l.accountCode, l.debitAmount, l.creditAmount])).toEqual([
      ["1100", "115.00", "0.00"],
      ["4000", "0.00", "100.00"],
      ["2100", "0.00", "15.00"],
    ]);
    await expect(w.as((tx) => updateInvoice(tx, approved.id, { salespersonId: w.ben }))).rejects.toThrow(/can't be edited/);
  });

  async function june() {
    const w = await setup();
    const one = await w.approve((await w.invoice(w.kobe.id, "100.00")).id);
    const two = await w.approve((await w.invoice(w.kobe.id, "200.00", { salespersonId: w.ben })).id);
    await w.approve((await w.invoice(w.rata.id, "50.00")).id);
    const credit = (
      await w.as((tx) =>
        createCreditNote(tx, {
          idempotencyKey: key("cn"),
          contactId: w.kobe.id,
          creditNoteDate: "2026-06-20",
          amountsMode: "exclusive",
          lines: [w.line("20.00")],
          salespersonId: one.salespersonId,
        }),
      )
    ).creditNote;
    await w.as((tx) => approveCreditNote(tx, credit.id, { idempotencyKey: key("approve") }));
    await w.invoice(w.kobe.id, "999.00", { salespersonId: w.ben });
    return { w, one, two, credit };
  }

  it("SR3: sales by salesperson for June ties to income", async () => {
    const { w, credit } = await june();
    expect(credit.salespersonId).toBe(w.aroha);
    const report = await w.as((tx) => salesBySalesperson(tx, { from: "2026-06-01", to: "2026-06-30" }));
    expect(report.rows.map((r) => r.name)).toEqual(["Aroha", "Ben", "Not set"]);
    expect(row(report, "Aroha")).toEqual([1, "100.00", "20.00", "80.00"]);
    expect(row(report, "Ben")).toEqual([1, "200.00", "0.00", "200.00"]);
    expect(row(report, "Not set")).toEqual([1, "50.00", "0.00", "50.00"]);
    expect(report.total).toEqual({ invoices: 3, sales: "350.00", creditNotes: "20.00", netSales: "330.00" });
    const pnl = await w.as((tx) => profitAndLoss(tx, { from: "2026-06-01", to: "2026-06-30" }));
    expect(pnl.revenue.total).toBe("330.00");
  });

  it("SR4: a void counts on its void date", async () => {
    const { w, two } = await june();
    await w.as((tx) => voidInvoice(tx, two.id, { idempotencyKey: key("void"), voidDate: "2026-07-05" }));
    const juneReport = await w.as((tx) => salesBySalesperson(tx, { from: "2026-06-01", to: "2026-06-30" }));
    expect(row(juneReport, "Ben")).toEqual([1, "200.00", "0.00", "200.00"]);
    const july = await w.as((tx) => salesBySalesperson(tx, { from: "2026-07-01", to: "2026-07-31" }));
    expect(row(july, "Ben")).toEqual([0, "-200.00", "0.00", "-200.00"]);
  });

  it("SR5: tax inclusive invoices count without GST", async () => {
    const w = await setup();
    await w.approve((await w.invoice(w.kobe.id, "115.00", { amountsMode: "inclusive" })).id);
    const report = await w.as((tx) => salesBySalesperson(tx, { from: "2026-06-01", to: "2026-06-30" }));
    expect(row(report, "Aroha")).toEqual([1, "100.00", "0.00", "100.00"]);
  });

  it("SR6: archived salespeople and changing a customer's default", async () => {
    const w = await setup();
    const withBen = await w.invoice(w.kobe.id, "10.00", { salespersonId: w.ben });
    const first = await w.invoice(w.kobe.id, "10.00");
    await w.as((tx) => updateSalesperson(tx, w.ben, { isActive: false }));
    await expect(w.invoice(w.kobe.id, "10.00", { salespersonId: w.ben })).rejects.toThrow("Ben is archived.");
    expect((await w.approve(withBen.id)).salespersonId).toBe(w.ben);
    await w.as((tx) => updateSalesperson(tx, w.aroha, { isActive: false }));
    expect((await w.invoice(w.kobe.id, "10.00")).salespersonId).toBeNull();
    await w.as((tx) => updateSalesperson(tx, w.ben, { isActive: true }));
    await w.as((tx) => updateContact(tx, w.kobe.id, { defaultSalespersonId: w.ben }));
    expect((await w.as((tx) => getInvoice(tx, first.id))).salespersonId).toBe(w.aroha);
    expect((await w.invoice(w.kobe.id, "10.00")).salespersonId).toBe(w.ben);
  });

  it("SR7: with the setting off, no new salesperson; existing ones stay", async () => {
    const w = await setup();
    const draft = await w.invoice(w.kobe.id, "10.00");
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: false }));
    expect((await w.invoice(w.kobe.id, "10.00")).salespersonId).toBeNull();
    await expect(w.invoice(w.kobe.id, "10.00", { salespersonId: w.aroha })).rejects.toThrow("Advanced features are off");
    const edited = await w.as((tx) => updateInvoice(tx, draft.id, { reference: "PO 1" }));
    expect(edited.salespersonId).toBe(w.aroha);
    expect((await w.approve(draft.id)).salespersonId).toBe(w.aroha);
  });

  it("SR8: each row lists the documents behind it", async () => {
    const { w, one, credit } = await june();
    const report = await w.as((tx) => salesBySalesperson(tx, { from: "2026-06-01", to: "2026-06-30" }));
    const aroha = report.rows.find((r) => r.name === "Aroha")!;
    expect(aroha.documents.map((d) => [d.kind, d.id, d.amount])).toEqual([
      ["invoice", one.id, "100.00"],
      ["credit_note", credit.id, "20.00"],
    ]);
  });

  it("over HTTP: viewers read the report and the list; only admins add salespeople", async () => {
    const { w } = await june();
    const viewerCookie = await sessionCookieFor(viewer);
    const cookie = await sessionCookieFor(owner);
    const read = await reportRoute.GET(
      apiRequest(`/api/reports/sales-by-salesperson?organisationId=${w.org}&from=2026-06-01&to=2026-06-30`, { cookie: viewerCookie }),
      noContext,
    );
    expect(read.status).toBe(200);
    expect(((await read.json()) as SalesBySalesperson).total.netSales).toBe("330.00");
    const body = { organisationId: w.org, name: "Cara" };
    expect((await salespeopleRoute.POST(apiRequest("/api/salespeople", { method: "POST", cookie: viewerCookie, body }), noContext)).status).toBe(403);
    expect((await salespeopleRoute.POST(apiRequest("/api/salespeople", { method: "POST", cookie, body }), noContext)).status).toBe(201);
  });
});
