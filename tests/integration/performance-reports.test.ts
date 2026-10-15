import { afterAll, beforeAll, expect, it } from "vitest";
import * as categoriesRoute from "@/app/api/reports/performance/categories/route";
import * as settingsRoute from "@/app/api/reports/performance/settings/route";
import * as statementsRoute from "@/app/api/reports/financial-statements/route";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { createBankTransaction } from "@/lib/bank/transactions";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { recordPayment } from "@/lib/invoices/payments";
import { postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { getStatementNotes } from "@/lib/reports/financial-statements";
import { performanceReportPdf } from "@/lib/reports/performance-report-pdf";
import {
  getPerformanceSettings,
  listAccountCategories,
  performanceFigures,
  savePerformanceSettings,
  saveServicePerformance,
  setAccountCategory,
} from "@/lib/reports/performance-report";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;

/** Examples NPR1-NPR10 in docs/ACCOUNTING-EXAMPLES.md ("Tier 3 and Tier 4 performance reports"). */
describeWithDatabase("Tier 3 and Tier 4 performance reports", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("club-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function organisation(options: { gst?: boolean } = {}) {
    organisations += 1;
    const org = `club-${organisations}-inc`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => updateOrganisationSettings(tx, { displayName: "Harbourview Bowling Club", gstRegistered: options.gst ?? false, financialYearEndMonth: 3 }));
    const accounts: Array<[string, string, string]> = [
      ["4010", "Subscriptions", "revenue"],
      ["4020", "Bar sales", "revenue"],
      ["4030", "Gaming trust grants", "revenue"],
      ["4040", "Donations", "revenue"],
      ["5200", "Bar purchases", "direct_costs"],
      ["6400", "Green maintenance", "expense"],
      ["1700", "Equipment", "fixed_asset"],
      ["2450", "Subscriptions in advance", "current_liability"],
    ];
    for (const [code, name, accountType] of accounts) await as((tx) => createAccount(tx, { code, name, accountType }));
    const choose = (accountCode: string, category: string, cashCategory?: string) => as((tx) => setAccountCategory(tx, { accountCode, category, cashCategory }));
    await choose("4010", "rev_membership");
    await choose("4020", "rev_commercial");
    await choose("4030", "rev_general_grants");
    await choose("4040", "rev_donations");
    await choose("4200", "rev_investment");
    await choose("5200", "exp_commercial");
    await choose("6200", "exp_employees");
    await choose("6400", "exp_service_delivery");
    await choose("2450", "li_deferred", "rev_membership");
    const contact = async (name: string, supplier = false) =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, ...(supplier ? { isSupplier: true } : { isCustomer: true }) }))).contact;
    const members = await contact("Members");
    const supplier = await contact("Clutha Beverages", true);
    const bankId = (await as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1000'"))).rows[0].id;
    const journal = (date: string, lines: Array<Record<string, string>>) => as((tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate: date, reference: "Club", lines }));
    const money = (kind: "receive" | "spend", date: string, accountCode: string, amount: string, taxCode?: string) =>
      as((tx) =>
        createBankTransaction(tx, {
          idempotencyKey: key("bt"),
          kind,
          accountId: bankId,
          contactId: members.id,
          date,
          amountsMode: taxCode ? "inclusive" : "no_tax",
          lines: [{ description: accountCode, accountCode, amount, ...(taxCode ? { taxCode } : {}) }],
        }),
      );
    const invoice = async (date: string, lines: Array<[string, string]>) => {
      const { invoice: draft } = await as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("i"),
          contactId: members.id,
          invoiceDate: date,
          dueDate: date,
          amountsMode: "no_tax",
          lines: lines.map(([accountCode, unitPrice]) => ({ description: accountCode, quantity: "1", unitPrice, accountCode })),
        }),
      );
      return (await as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("a") }))).invoice;
    };
    const pay = (invoiceId: string, date: string, amount: string) => as((tx) => recordPayment(tx, invoiceId, { idempotencyKey: key("p"), paymentDate: date, amount, bankAccountCode: "1000" }));
    const bill = async (date: string, accountCode: string, amount: string) => {
      const { bill: draft } = await as((tx) =>
        createBill(tx, {
          idempotencyKey: key("b"),
          contactId: supplier.id,
          billDate: date,
          dueDate: date,
          supplierInvoiceNumber: key("n"),
          amountsMode: "no_tax",
          lines: [{ description: accountCode, quantity: "1", unitPrice: amount, accountCode }],
        }),
      );
      return (await as((tx) => approveBill(tx, draft.id, { idempotencyKey: key("a") }))).bill;
    };
    const payBill = (billId: string, date: string, amount: string) => as((tx) => recordSupplierPayment(tx, billId, { idempotencyKey: key("sp"), paymentDate: date, amount, bankAccountCode: "1000" }));
    return { org, as, journal, money, invoice, pay, bill, payBill, choose };
  }

  /** The year in the examples' setup. */
  async function clubYear() {
    const w = await organisation();
    // Opening balances, brought forward at the end of the year before.
    await w.journal("2025-03-31", [
      { accountCode: "1000", debitAmount: "12000.00" },
      { accountCode: "1700", debitAmount: "8000.00" },
      { accountCode: "3200", creditAmount: "20000.00" },
    ]);
    const subs = await w.invoice("2025-04-01", [["4010", "6000.00"]]);
    await w.pay(subs.id, "2025-05-01", "5700.00");
    await w.money("receive", "2025-12-20", "4020", "9500.00");
    await w.money("receive", "2025-08-15", "4030", "5000.00");
    await w.money("receive", "2025-09-01", "4040", "750.00");
    await w.money("receive", "2026-03-31", "4200", "120.00");
    await w.money("receive", "2026-03-20", "2450", "450.00");
    const bar = await w.bill("2025-06-01", "5200", "4200.00");
    await w.payBill(bar.id, "2025-07-01", "3900.00");
    await w.money("spend", "2025-11-30", "6200", "6000.00");
    await w.money("spend", "2025-10-15", "6400", "3800.00");
    await w.money("spend", "2026-01-31", "6110", "1450.00");
    await w.journal("2026-03-31", [
      { accountCode: "6300", debitAmount: "1000.00" },
      { accountCode: "1700", creditAmount: "1000.00" },
    ]);
    await w.money("spend", "2025-10-01", "1700", "2500.00");
    return w;
  }

  it("NPR1-NPR3: Tier 3 performance, position and cash flows by category", async () => {
    const w = await clubYear();
    const { current } = await w.as((tx) => performanceFigures(tx, "2026-03-31"));
    expect(current.revenue).toEqual([
      { key: "rev_donations", amount: "750.00" },
      { key: "rev_general_grants", amount: "5000.00" },
      { key: "rev_membership", amount: "6000.00" },
      { key: "rev_commercial", amount: "9500.00" },
      { key: "rev_investment", amount: "120.00" },
    ]);
    expect(current.expenses).toEqual([
      { key: "exp_employees", amount: "6000.00" },
      { key: "exp_commercial", amount: "4200.00" },
      { key: "exp_service_delivery", amount: "3800.00" },
      { key: "exp_other", amount: "2450.00" },
    ]);
    expect(current.surplus).toBe("4920.00");
    expect(current.assets).toEqual({
      current: [
        { key: "as_cash", amount: "15870.00" },
        { key: "as_debtors", amount: "300.00" },
      ],
      nonCurrent: [{ key: "as_ppe", amount: "9500.00" }],
      total: "25670.00",
    });
    expect(current.liabilities).toEqual({
      current: [
        { key: "li_creditors", amount: "300.00" },
        { key: "li_deferred", amount: "450.00" },
      ],
      nonCurrent: [],
      total: "750.00",
    });
    expect([current.netAssets, current.equity]).toEqual(["24920.00", [{ key: "eq_accumulated", amount: "24920.00" }]]);
    expect(current.cash).toMatchObject({
      opening: "12000.00",
      closing: "15870.00",
      receipts: [
        { key: "rev_donations", amount: "750.00" },
        { key: "rev_general_grants", amount: "5000.00" },
        { key: "rev_membership", amount: "6150.00" },
        { key: "rev_commercial", amount: "9500.00" },
        { key: "rev_investment", amount: "120.00" },
      ],
      payments: [
        { key: "exp_employees", amount: "6000.00" },
        { key: "exp_commercial", amount: "3900.00" },
        { key: "exp_service_delivery", amount: "3800.00" },
        { key: "exp_other", amount: "1450.00" },
      ],
      gst: "0.00",
      otherPayments: [{ key: "oa_buy_ppe", amount: "2500.00" }],
    });
  });

  it("NPR4 and NPR5: Tier 4 cash from 12,000.00 to 15,870.00, and significant assets and liabilities", async () => {
    const w = await clubYear();
    const { current, prior } = await w.as((tx) => performanceFigures(tx, "2026-03-31"));
    expect(current.cash.opening).toBe("12000.00");
    expect(current.cash.receipts.map((row) => row.amount)).toEqual(["750.00", "5000.00", "6150.00", "9500.00", "120.00"]);
    expect(current.cash.payments.map((row) => row.amount)).toEqual(["6000.00", "3900.00", "3800.00", "1450.00"]);
    expect(current.cash.closing).toBe("15870.00");
    expect(current.cash.accounts).toEqual([{ code: "1000", name: "Business bank account", amount: "15870.00" }]);
    // Last year's column: the opening balances only.
    expect(prior.cash).toMatchObject({ opening: "0.00", closing: "12000.00" });
    expect(prior.surplus).toBe("0.00");
    // NPR5: significant assets and liabilities for the Tier 4 notes.
    expect(current.significantAssets.map((row) => [row.code, row.amount])).toEqual([
      ["1100", "300.00"],
      ["1700", "9500.00"],
    ]);
    expect(current.significantLiabilities.map((row) => [row.code, row.amount])).toEqual([
      ["2000", "300.00"],
      ["2450", "450.00"],
    ]);
    // The Tier 4 PDF builds, with the cash statement.
    await w.as((tx) => savePerformanceSettings(tx, { format: "tier4", entity: { legalName: "Harbourview Bowling Club Incorporated" } }));
    const pdf = await w.as((tx) => performanceReportPdf(tx, { yearEnd: "2026-03-31" }));
    expect(pdf.fileName).toBe("Harbourview Bowling Club Incorporated performance report 2026-03-31.pdf");
    expect(Buffer.from(pdf.bytes).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("NPR6: a customer payment is split by the invoice it paid", async () => {
    const w = await organisation();
    const full = await w.invoice("2025-06-01", [["4010", "600.00"], ["4020", "400.00"]]);
    await w.pay(full.id, "2025-06-10", "1000.00");
    const half = await w.invoice("2025-06-01", [["4010", "600.00"], ["4020", "400.00"]]);
    await w.pay(half.id, "2025-06-10", "500.00");
    const { current } = await w.as((tx) => performanceFigures(tx, "2026-03-31"));
    expect(current.cash.receipts).toEqual([
      { key: "rev_membership", amount: "900.00" },
      { key: "rev_commercial", amount: "600.00" },
    ]);
  });

  it("NPR7: a credit card counts as cash", async () => {
    const w = await organisation();
    await w.journal("2025-06-01", [
      { accountCode: "6400", debitAmount: "200.00" },
      { accountCode: "2400", creditAmount: "200.00" },
    ]);
    await w.journal("2025-06-20", [
      { accountCode: "2400", debitAmount: "200.00" },
      { accountCode: "1000", creditAmount: "200.00" },
    ]);
    const { current } = await w.as((tx) => performanceFigures(tx, "2026-03-31"));
    expect(current.cash.payments).toEqual([{ key: "exp_service_delivery", amount: "200.00" }]);
    expect(current.cash.closing).toBe("-200.00");
  });

  it("NPR8: registered for GST, amounts exclude GST and GST is one line", async () => {
    const w = await organisation({ gst: true });
    await w.money("receive", "2025-08-15", "4030", "1150.00", "GST");
    await w.money("spend", "2025-09-15", "6400", "230.00", "GST");
    await w.journal("2025-10-28", [
      { accountCode: "2100", debitAmount: "50.00" },
      { accountCode: "1000", creditAmount: "50.00" },
    ]);
    const { current } = await w.as((tx) => performanceFigures(tx, "2026-03-31"));
    expect(current.cash).toMatchObject({
      receipts: [{ key: "rev_general_grants", amount: "1000.00" }],
      payments: [{ key: "exp_service_delivery", amount: "200.00" }],
      gst: "70.00",
    });
  });

  it("NPR9 and NPR10: service performance, the format choice, drafts and categories", async () => {
    const w = await clubYear();
    expect((await w.as((tx) => getPerformanceSettings(tx))).format).toBe("special_purpose");
    // Special purpose drafts until a performance report format is chosen.
    expect((await w.as((tx) => getStatementNotes(tx))).notes[1].title).toBe("Basis of preparation");
    const cookie = await sessionCookieFor(owner);
    const saved = await settingsRoute.PUT(
      apiRequest("/api/reports/performance/settings", { method: "PUT", cookie, body: { organisationId: w.org, format: "tier3", entity: { legalName: "Harbourview Bowling Club Incorporated", registrationNumber: "CC12345" } } }),
      noContext,
    );
    expect(saved.status).toBe(200);
    const notes = await w.as((tx) => getStatementNotes(tx));
    expect(notes.notes[0].body).toContain("Tier 3 (NFP) Standard");
    await w.as((tx) =>
      saveServicePerformance(tx, {
        yearEnd: "2026-03-31",
        activities: [
          {
            name: "Bowls for members and the community",
            description: "Club days, tournaments and open days on our two greens.",
            measures: [
              { label: "Club days held", current: "52", prior: "50" },
              { label: "Members", current: "40", prior: "37" },
              { label: "Community open days", current: "4", prior: "3" },
            ],
          },
        ],
      }),
    );
    const pdf = await statementsRoute.GET(apiRequest(`/api/reports/financial-statements?organisationId=${w.org}&yearEnd=2026-03-31`, { cookie }), noContext);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-disposition")).toContain("performance report 2026-03-31.pdf");
    // Back to special purpose: the same books give the special purpose statements.
    await w.as((tx) => savePerformanceSettings(tx, { format: "special_purpose" }));
    const again = await statementsRoute.GET(apiRequest(`/api/reports/financial-statements?organisationId=${w.org}&yearEnd=2026-03-31`, { cookie }), noContext);
    expect(again.headers.get("content-disposition")).toContain("financial statements 2026-03-31.pdf");

    // Categories: chosen ones and Tohyee's suggestions, and the suggestion comes back when cleared.
    const listed = await categoriesRoute.GET(apiRequest(`/api/reports/performance/categories?organisationId=${w.org}`, { cookie }), noContext);
    const { accounts } = (await listed.json()) as { accounts: Awaited<ReturnType<typeof listAccountCategories>> };
    expect(accounts.find((a) => a.code === "4010")).toMatchObject({ category: "rev_membership", suggested: false });
    expect(accounts.find((a) => a.code === "6110")).toMatchObject({ category: "exp_other", suggested: true });
    expect(accounts.find((a) => a.code === "2400")).toMatchObject({ category: "li_overdraft", suggested: true });
    expect(accounts.find((a) => a.code === "2240")).toMatchObject({ category: "li_employee", suggested: true });
    const cleared = await w.as((tx) => setAccountCategory(tx, { accountCode: "4010", category: null }));
    expect(cleared.find((a) => a.code === "4010")).toMatchObject({ category: "rev_other", suggested: true });
    await expect(w.as((tx) => setAccountCategory(tx, { accountCode: "4010", category: "as_cash" }))).rejects.toThrow(/category/);
    await expect(w.as((tx) => setAccountCategory(tx, { accountCode: "4010", category: "rev_membership", cashCategory: "rev_donations" }))).rejects.toThrow(/balance sheet/);
    const events = await w.as((tx) => tx.query<{ event_type: string }>("select event_type from audit_events where event_type like 'reports.performance%' order by id"));
    expect(events.rows.map((row) => row.event_type)).toContain("reports.performance_settings_saved");
  });
});
