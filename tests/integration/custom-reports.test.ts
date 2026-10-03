import { afterAll, beforeAll, expect, it } from "vitest";
import * as reportRoute from "@/app/api/custom-reports/[reportId]/route";
import * as reportsRoute from "@/app/api/custom-reports/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact, updateContact } from "@/lib/contacts/service";
import { createCustomField } from "@/lib/custom-fields/service";
import { createCustomerGroup } from "@/lib/customers/service";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { accountTransactions, type AccountTransactions } from "@/lib/reports/account-transactions";
import {
  computeCustomReport,
  createCustomReport,
  type CustomReport,
  deleteCustomReport,
  getCustomReport,
  listCustomReports,
  publishCustomReport,
  setCustomReportArchived,
  updateCustomReport,
} from "@/lib/reports/custom";
import type {
  ComputedBlock,
  CustomReportFigures,
  CustomReportLayout,
  FinancialReportBase,
  ReportRow,
  TransactionCustomReportFigures,
  TransactionReportBase,
} from "@/lib/reports/custom-layout";
import { balanceSheet, profitAndLoss } from "@/lib/reports/financial";
import { journalReport, type JournalReport } from "@/lib/reports/journal-report";
import type { SalesBySalesperson } from "@/lib/reports/sales-by-salesperson";
import { createSalesperson } from "@/lib/salespeople/service";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
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

/**
 * Examples CR1-CR10 in docs/ACCOUNTING-EXAMPLES.md ("Custom reports"). Each
 * test gets its own organisation with the setup journals (31 March year end).
 */
describeWithDatabase("custom reports", () => {
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
    const org = `custom-reports-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const journal = (postingDate: string, debit: string, credit: string, amount: string) =>
      as((tx) =>
        postJournal(tx, {
          idempotencyKey: key("journal"),
          postingDate,
          reference: "Setup",
          lines: [
            { accountCode: debit, debitAmount: amount, creditAmount: "0" },
            { accountCode: credit, debitAmount: "0", creditAmount: amount },
          ],
        }),
      );
    await journal("2026-03-01", "1000", "3000", "5000.00");
    await journal("2026-03-20", "1000", "4000", "500.00");
    await journal("2026-04-10", "1000", "4000", "1000.00");
    await journal("2026-04-15", "6010", "1000", "100.00");
    await journal("2026-05-12", "1000", "4000", "1500.00");
    await journal("2026-05-13", "5000", "1000", "400.00");
    await journal("2026-06-08", "1000", "4000", "1200.00");
    await journal("2026-06-09", "5000", "1000", "300.00");
    await journal("2026-06-20", "6010", "1000", "250.00");
    await journal("2026-06-30", "1000", "4200", "20.00");

    const create = async (base: FinancialReportBase, periodEnd = "2026-06-30") =>
      (await as((tx) => createCustomReport(tx, { idempotencyKey: key("create"), base, periodEnd }))).report as CustomReport & {
        base: FinancialReportBase;
        layout: CustomReportLayout;
      };
    /** Saves a changed layout and returns the figures. */
    const save = async (report: CustomReport, change: (layout: CustomReportLayout) => void) => {
      const current = (await as((tx) => getCustomReport(tx, report.id))).report;
      const layout = structuredClone(current.layout) as CustomReportLayout;
      change(layout);
      return as((tx) => updateCustomReport(tx, report.id, { layout, version: current.version }));
    };
    return { org, as, journal, create, save };
  }

  const firstTable = (figures: CustomReportFigures) => figures.blocks.find((block) => block.kind === "table") as Extract<ComputedBlock, { kind: "table" }>;
  /** label -> values in the column order shown. */
  const rowsOf = (figures: CustomReportFigures, block = firstTable(figures)) =>
    Object.fromEntries(block.rows.filter((row) => row.kind !== "heading").map((row) => [row.label, figures.columns.map((column) => row.values[column.key])]));
  const mainRows = (layout: CustomReportLayout) => (layout.blocks[0] as { rows: ReportRow[] }).rows;

  it("CR1: a profit and loss copy for June equals the standard profit and loss", async () => {
    const w = await setup();
    const report = await w.create("profit_and_loss");
    expect(report).toMatchObject({ kind: "draft", base: "profit_and_loss", title: "Profit and loss", version: 1 });
    const { figures } = await w.as((tx) => getCustomReport(tx, report.id));
    expect(figures.columns.map((column) => [column.label, column.from, column.to])).toEqual([["Jun 2026", "2026-06-01", "2026-06-30"]]);
    expect(rowsOf(figures)).toEqual({
      Revenue: ["1200.00"],
      "Cost of sales": ["300.00"],
      "Gross profit": ["900.00"],
      "Other income": ["20.00"],
      Expenses: ["250.00"],
      "Net profit": ["670.00"],
    });
    expect(firstTable(figures).rows[0].lines).toEqual([{ code: "4000", name: "Sales", values: { p0: "1200.00" } }]);
    const standard = await w.as((tx) => profitAndLoss(tx, { from: "2026-06-01", to: "2026-06-30" }));
    expect(standard).toMatchObject({ grossProfit: "900.00", netProfit: "670.00" });
    expect(figures.notInReport).toEqual([]);
    expect(figures.inSeveralGroups).toEqual([]);
  });

  it("CR2: three months with difference, % and year to date", async () => {
    const w = await setup();
    const report = await w.create("profit_and_loss");
    const { figures } = await w.save(report, (layout) => {
      layout.columns = { ...layout.columns, periodCount: 3, difference: true, percent: true, yearToDate: true };
    });
    expect(figures.columns.map((column) => column.label)).toEqual(["Jun 2026", "May 2026", "Apr 2026", "Difference", "%", "Year to date"]);
    expect(figures.columns.find((column) => column.key === "ytd")).toMatchObject({ from: "2026-04-01", to: "2026-06-30" });
    expect(rowsOf(figures)).toEqual({
      Revenue: ["1200.00", "1500.00", "1000.00", "-300.00", "-20.0", "3700.00"],
      "Cost of sales": ["300.00", "400.00", "0.00", "-100.00", "-25.0", "700.00"],
      "Gross profit": ["900.00", "1100.00", "1000.00", "-200.00", "-18.2", "3000.00"],
      "Other income": ["20.00", "0.00", "0.00", "20.00", null, "20.00"],
      Expenses: ["250.00", "0.00", "100.00", "250.00", null, "350.00"],
      "Net profit": ["670.00", "1100.00", "900.00", "-430.00", "-39.1", "2670.00"],
    });
    const standard = await w.as((tx) => profitAndLoss(tx, { to: "2026-06-30" }));
    expect(standard.netProfit).toBe("2670.00");
  });

  it("CR3: two quarters", async () => {
    const w = await setup();
    const report = await w.create("profit_and_loss");
    const { figures } = await w.save(report, (layout) => {
      layout.columns = { ...layout.columns, periodLength: "quarter", periodCount: 2, difference: true, percent: true };
    });
    expect(figures.columns.slice(0, 2).map((column) => [column.label, column.from, column.to])).toEqual([
      ["Apr - Jun 2026", "2026-04-01", "2026-06-30"],
      ["Jan - Mar 2026", "2026-01-01", "2026-03-31"],
    ]);
    expect(rowsOf(figures)["Net profit"]).toEqual(["2670.00", "500.00", "2170.00", "434.0"]);
  });

  it("CR4: renaming, moving, formulas, account groups and what's left out", async () => {
    const w = await setup();
    const report = await w.create("profit_and_loss");
    let { figures } = await w.save(report, (layout) => {
      const rows = mainRows(layout);
      const revenue = rows.find((row) => row.id === "revenue")!;
      revenue.label = "Sales";
      if (revenue.kind === "group") revenue.showAccounts = false;
      const expenses = rows.splice(rows.findIndex((row) => row.id === "expenses"), 1)[0];
      rows.splice(2, 0, expenses);
      rows.push({ id: "trading", kind: "formula", label: "Trading result", terms: [{ rowId: "gross_profit", sign: 1 }, { rowId: "expenses", sign: -1 }] });
      rows.push({ id: "fees", kind: "group", label: "Accounting fees", accountTypes: [], accountCodes: ["6010"], showAccounts: true });
    });
    const rows = rowsOf(figures);
    expect(Object.keys(rows)).toEqual(["Sales", "Cost of sales", "Expenses", "Gross profit", "Other income", "Net profit", "Trading result", "Accounting fees"]);
    expect(rows).toMatchObject({ Sales: ["1200.00"], "Gross profit": ["900.00"], "Net profit": ["670.00"], "Trading result": ["650.00"], "Accounting fees": ["250.00"] });
    expect(firstTable(figures).rows[0].showAccounts).toBe(false);
    expect(figures.inSeveralGroups).toEqual([{ tableTitle: "", code: "6010", name: "Accounting fees", groups: ["Expenses", "Accounting fees"] }]);

    await expect(w.save(report, (layout) => {
      const list = mainRows(layout);
      list.splice(list.findIndex((row) => row.id === "other_income"), 1);
    })).rejects.toThrow("Net profit uses a row that isn't in its table.");
    ({ figures } = await w.save(report, (layout) => {
      const list = mainRows(layout);
      list.splice(list.findIndex((row) => row.id === "net_profit"), 1);
      list.splice(list.findIndex((row) => row.id === "other_income"), 1);
    }));
    expect(figures.notInReport).toEqual([{ code: "4200", name: "Interest income", values: { p0: "20.00" } }]);
  });

  it("CR5: a second table and a note, in order", async () => {
    const w = await setup();
    const report = await w.create("profit_and_loss");
    let { figures } = await w.save(report, (layout) => {
      layout.blocks.push({ id: "cash", kind: "table", title: "Cash", rows: [{ id: "bank", kind: "group", label: "Bank", accountTypes: [], accountCodes: ["1000"], showAccounts: false }] });
      layout.blocks.push({ id: "note", kind: "text", text: "Figures are unaudited." });
    });
    expect(figures.blocks.map((block) => [block.kind, block.id])).toEqual([
      ["table", "main"],
      ["table", "cash"],
      ["text", "note"],
    ]);
    const cash = figures.blocks[1] as Extract<ComputedBlock, { kind: "table" }>;
    expect(rowsOf(figures, cash)).toEqual({ Bank: ["670.00"] });
    ({ figures } = await w.save(report, (layout) => {
      const note = layout.blocks.pop()!;
      layout.blocks.unshift(note);
    }));
    expect(figures.blocks.map((block) => block.id)).toEqual(["note", "main", "cash"]);
  });

  it("CR6: a balance sheet copy for two months equals the standard balance sheet", async () => {
    const w = await setup();
    const report = await w.create("balance_sheet");
    const { figures } = await w.save(report, (layout) => {
      layout.columns = { ...layout.columns, periodCount: 2, difference: true, percent: true };
    });
    expect(figures.columns.map((column) => [column.label, column.from, column.to])).toEqual([
      ["30 Jun 2026", null, "2026-06-30"],
      ["31 May 2026", null, "2026-05-31"],
      ["Difference", null, null],
      ["%", null, null],
    ]);
    expect(rowsOf(figures)).toEqual({
      Assets: ["8170.00", "7500.00", "670.00", "8.9"],
      Liabilities: ["0.00", "0.00", "0.00", null],
      "Net assets": ["8170.00", "7500.00", "670.00", "8.9"],
      "Equity accounts": ["5000.00", "5000.00", "0.00", "0.0"],
      "Earnings from previous years": ["500.00", "500.00", "0.00", "0.0"],
      "Current year earnings": ["2670.00", "2000.00", "670.00", "33.5"],
      "Total equity": ["8170.00", "7500.00", "670.00", "8.9"],
    });
    for (const [asAt, column] of [["2026-06-30", 0], ["2026-05-31", 1]] as const) {
      const standard = await w.as((tx) => balanceSheet(tx, { asAt }));
      expect(standard.assets.total).toBe(rowsOf(figures).Assets[column]);
      expect(standard.equity.currentYearEarnings).toBe(rowsOf(figures)["Current year earnings"][column]);
      expect(standard.equity.previousYearsEarnings).toBe(rowsOf(figures)["Earnings from previous years"][column]);
    }
    await expect(w.save(report, (layout) => {
      layout.columns.yearToDate = true;
    })).rejects.toThrow(/no year to date column/);
  });

  it("CR7: a published report is a frozen copy; archive, bring back, delete", async () => {
    const w = await setup();
    const draft = await w.create("profit_and_loss");
    await w.save(draft, (layout) => {
      layout.columns = { ...layout.columns, periodCount: 3, difference: true, percent: true, yearToDate: true };
    });
    const publishKey = key("publish");
    const { created, report: published } = await w.as((tx) => publishCustomReport(tx, draft.id, { idempotencyKey: publishKey }));
    expect(created).toBe(true);
    expect(published).toMatchObject({ kind: "published", publishedFromId: draft.id, title: "Profit and loss" });
    expect((await w.as((tx) => publishCustomReport(tx, draft.id, { idempotencyKey: publishKey }))).report.id).toBe(published.id);

    await w.journal("2026-06-15", "1000", "4000", "100.00");
    const later = await w.as((tx) => getCustomReport(tx, draft.id));
    expect(rowsOf(later.figures).Revenue[0]).toBe("1300.00");
    expect(rowsOf(later.figures)["Net profit"][0]).toBe("770.00");
    const frozen = await w.as((tx) => getCustomReport(tx, published.id));
    expect(rowsOf(frozen.figures).Revenue[0]).toBe("1200.00");
    expect(rowsOf(frozen.figures)["Net profit"][0]).toBe("670.00");

    await expect(w.as((tx) => updateCustomReport(tx, published.id, { layout: published.layout, version: published.version }))).rejects.toThrow(
      "A published report can't be changed.",
    );
    await expect(w.as((tx) => deleteCustomReport(tx, published.id))).rejects.toThrow("Archive it instead.");
    await expect(w.as((tx) => tx.query("update custom_reports set title = 'Changed' where id = $1", [published.id]))).rejects.toThrow(/can't be changed/);
    await expect(w.as((tx) => tx.query("delete from custom_reports where id = $1", [published.id]))).rejects.toThrow(/can't be deleted/);

    expect((await w.as((tx) => listCustomReports(tx, "published"))).map((r) => r.id)).toEqual([published.id]);
    await w.as((tx) => setCustomReportArchived(tx, published.id, true));
    expect(await w.as((tx) => listCustomReports(tx, "published"))).toEqual([]);
    expect((await w.as((tx) => listCustomReports(tx, "archived"))).map((r) => r.id)).toEqual([published.id]);
    await w.as((tx) => setCustomReportArchived(tx, published.id, false));
    expect((await w.as((tx) => listCustomReports(tx, "published"))).map((r) => r.id)).toEqual([published.id]);

    await w.as((tx) => deleteCustomReport(tx, draft.id));
    expect(await w.as((tx) => listCustomReports(tx, "drafts"))).toEqual([]);
    // The published copy stays.
    expect(rowsOf((await w.as((tx) => getCustomReport(tx, published.id))).figures)["Net profit"][0]).toBe("670.00");
  });

  it("CR8: refused, and nothing is saved", async () => {
    const w = await setup();
    const report = await w.create("profit_and_loss");
    const refused = async (change: (layout: CustomReportLayout) => void, message: string | RegExp) => {
      await expect(w.save(report, change)).rejects.toThrow(message);
    };
    await refused((l) => void (l.columns.periodEnd = "2026-06-15"), "The columns must end on the last day of a month (for example 2026-06-30).");
    await refused((l) => void (l.columns.periodCount = 0), "A report has 1 to 12 period columns.");
    await refused((l) => void (l.columns.periodCount = 13), "A report has 1 to 12 period columns.");
    await refused((l) => void Object.assign(l.columns, { periodCount: 2, percent: true }), "A % column needs the difference column.");
    await refused((l) => void (l.columns.difference = true), "A difference column needs at least two period columns.");
    await refused((l) => {
      const rows = mainRows(l);
      rows.push({ id: "loop", kind: "formula", label: "Loop", terms: [{ rowId: "loop", sign: 1 }] });
    }, "Loop can't use itself.");
    await refused((l) => {
      const rows = mainRows(l);
      rows.push({ id: "a", kind: "formula", label: "A", terms: [{ rowId: "b", sign: 1 }] });
      rows.push({ id: "b", kind: "formula", label: "B", terms: [{ rowId: "a", sign: 1 }] });
    }, /uses itself through another formula/);
    await refused((l) => {
      l.blocks.push({ id: "other", kind: "table", title: "Other", rows: [{ id: "x", kind: "formula", label: "X", terms: [{ rowId: "revenue", sign: 1 }] }] });
    }, "X uses a row that isn't in its table.");
    await refused((l) => {
      mainRows(l).push({ id: "odd", kind: "group", label: "Odd", accountTypes: [], accountCodes: ["9999"], showAccounts: true });
    }, "There's no account 9999.");
    await refused((l) => void (l.title = " "), "The title is required.");
    await refused((l) => void (l.title = "x".repeat(201)), "The title can be at most 200 characters.");
    await refused((l) => void l.blocks.push({ id: "n", kind: "text", text: "x".repeat(5001) }), "A note can be at most 5,000 characters.");
    await refused((l) => {
      for (let i = 0; i < 20; i += 1) l.blocks.push({ id: `n${i}`, kind: "text", text: "Note" });
    }, "The tables and notes can have at most 20 entries.");
    await refused((l) => {
      const rows = mainRows(l);
      for (let i = 0; i < 95; i += 1) rows.push({ id: `h${i}`, kind: "heading", label: "Heading" });
    }, "A table's rows can have at most 100 entries.");
    await refused((l) => {
      mainRows(l).push({ id: "e", kind: "earnings", label: "Earnings", which: "current" });
    }, "Earnings rows are only on balance sheets.");
    const unchanged = await w.as((tx) => getCustomReport(tx, report.id));
    expect(unchanged.report.version).toBe(1);
    // Saving from an old version is refused.
    await w.save(report, (l) => void (l.title = "June"));
    await expect(w.as((tx) => updateCustomReport(tx, report.id, { layout: unchanged.report.layout, version: 1 }))).rejects.toThrow(/Someone else has changed this report/);
  });

  it("CR9: each column equals the standard report for its dates", async () => {
    const w = await setup();
    const pnl = await w.create("profit_and_loss");
    const { figures } = await w.save(pnl, (layout) => {
      layout.columns = { ...layout.columns, periodCount: 6, yearToDate: true };
    });
    for (const column of figures.columns) {
      const standard = await w.as((tx) => profitAndLoss(tx, { from: column.from, to: column.to }));
      expect(rowsOf(figures)["Net profit"][figures.columns.indexOf(column)]).toBe(standard.netProfit);
    }
    const bs = await w.create("balance_sheet");
    const sheet = (await w.save(bs, (layout) => void (layout.columns.periodCount = 6))).figures;
    for (const column of sheet.columns) {
      const standard = await w.as((tx) => balanceSheet(tx, { asAt: column.to }));
      expect(rowsOf(sheet)["Total equity"][sheet.columns.indexOf(column)]).toBe(standard.equity.total);
      expect(rowsOf(sheet)["Net assets"][sheet.columns.indexOf(column)]).toBe(standard.assets.total);
    }
    // Working a report out posts nothing.
    const journals = async () => (await w.as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n;
    const before = await journals();
    await w.as((tx) => computeCustomReport(tx, "profit_and_loss", pnl.layout));
    expect(await journals()).toBe(before);
  });

  it("CR10: viewers can open reports; only bookkeepers and admins change them", async () => {
    const w = await setup();
    const cookie = await sessionCookieFor(owner);
    const viewerCookie = await sessionCookieFor(viewer);
    const body = { organisationId: w.org, idempotencyKey: key("http"), base: "profit_and_loss", periodEnd: "2026-06-30" };
    expect((await reportsRoute.POST(apiRequest("/api/custom-reports", { method: "POST", cookie: viewerCookie, body }), noContext)).status).toBe(403);
    const created = await reportsRoute.POST(apiRequest("/api/custom-reports", { method: "POST", cookie, body }), noContext);
    expect(created.status).toBe(201);
    const { report } = (await created.json()) as { report: CustomReport };
    const context = { params: Promise.resolve({ reportId: report.id }) };
    const opened = await reportRoute.GET(apiRequest(`/api/custom-reports/${report.id}?organisationId=${w.org}`, { cookie: viewerCookie }), context);
    expect(opened.status).toBe(200);
    expect(rowsOf(((await opened.json()) as { figures: CustomReportFigures }).figures)["Net profit"]).toEqual(["670.00"]);
    const listed = await reportsRoute.GET(apiRequest(`/api/custom-reports?organisationId=${w.org}&view=drafts`, { cookie: viewerCookie }), noContext);
    expect(((await listed.json()) as { reports: unknown[] }).reports).toHaveLength(1);
    const put = (c: string) =>
      reportRoute.PUT(
        apiRequest(`/api/custom-reports/${report.id}`, { method: "PUT", cookie: c, body: { organisationId: w.org, layout: { ...report.layout, title: "June" }, version: 1 } }),
        { params: Promise.resolve({ reportId: report.id }) },
      );
    expect((await put(viewerCookie)).status).toBe(403);
    const saved = await put(cookie);
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { report: CustomReport }).report).toMatchObject({ title: "June", version: 2 });
  });

  /** CR11-CR15 setup: Kobe Ltd with contact, document and line fields, and invoice INV-REPORT-1 on 20 May 2026. */
  async function transactionSetup() {
    const w = await setup();
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const field = async (record: "contact" | "document" | "line", label: string, usedOn: string[]) =>
      (await w.as((tx) => createCustomField(tx, { record, label, type: "text", usedOn }))).fields.find((entry) => entry.label === label)!;
    const region = await field("contact", "Region", ["customer"]);
    const channel = await field("document", "Channel", ["invoice"]);
    const project = await field("line", "Project", ["invoice", "journal"]);
    const aroha = (await w.as((tx) => createSalesperson(tx, { name: "Aroha" }))).salespeople[0].id;
    const group = (await w.as((tx) => createCustomerGroup(tx, { name: "Trade" }))).customerGroups[0];
    const kobe = (
      await w.as((tx) =>
        createContact(tx, {
          idempotencyKey: key("contact"),
          name: "Kobe Ltd",
          isCustomer: true,
          email: "accounts@kobe.example.nz",
          postalAddress: "1 Kauri Road, Dunedin",
          customerGroupId: group.id,
          defaultSalespersonId: aroha,
          customFields: { [region.id]: "Otago" },
        }),
      )
    ).contact;
    const location = (await w.as((tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "location")!;
    const dunedin = (await w.as((tx) => createTrackingValue(tx, { categoryId: location.id, name: "Dunedin" })))
      .categories.find((category) => category.id === location.id)!.values.find((value) => value.name === "Dunedin")!;
    const { invoice } = await w.as((tx) =>
      createInvoice(tx, {
        idempotencyKey: key("invoice"),
        contactId: kobe.id,
        invoiceDate: "2026-05-20",
        dueDate: "2026-06-19",
        amountsMode: "exclusive",
        customFields: { [channel.id]: "Web" },
        lines: [
          {
            description: "Consulting",
            quantity: "1",
            unitPrice: "100.00",
            accountCode: "4000",
            taxCode: "GST",
            customFields: { [project.id]: "Fit-out" },
            tracking: { [location.id]: dunedin.id },
          },
        ],
      }),
    );
    await w.as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }));
    const saveLayout = async (base: TransactionReportBase, layout: Record<string, unknown>) => {
      const { report } = await w.as((tx) => createCustomReport(tx, { idempotencyKey: key("create"), base, periodEnd: "2026-05-31" }));
      return w.as((tx) => updateCustomReport(tx, report.id, { layout, version: report.version }));
    };
    const refused = async (base: TransactionReportBase, layout: { columns: string[] } & Record<string, unknown>, extra: string[]) => {
      const { report } = await w.as((tx) => createCustomReport(tx, { idempotencyKey: key("create"), base, periodEnd: "2026-05-31" }));
      for (const column of extra) {
        await expect(
          w.as((tx) => updateCustomReport(tx, report.id, { layout: { ...layout, columns: [...layout.columns, column] }, version: report.version })),
        ).rejects.toThrow("That report column isn't available.");
      }
    };
    const journalCount = async () => (await w.as((tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals"))).rows[0].count;
    return { ...w, region, channel, project, location, dunedin, kobe, aroha, invoice, saveLayout, refused, journalCount };
  }

  it("CR11: account transactions with contact, document, line and tracking columns keeps its figures", async () => {
    const w = await transactionSetup();
    const accountId = (await w.as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '4000'"))).rows[0].id;
    const journalsBefore = await w.journalCount();
    const layout = {
      title: "Sales detail",
      filters: { from: "2026-04-01", to: "2026-05-31", accountId },
      columns: [
        "date",
        "source",
        "contact.email",
        "contact.address",
        "contact.group",
        `contact.custom.${w.region.id}`,
        `document.custom.${w.channel.id}`,
        `line.custom.${w.project.id}`,
        `tracking.${w.location.id}`,
        "credit",
        "balance",
      ],
    };
    const saved = await w.saveLayout("account_transactions", layout);
    expect(saved.report).toMatchObject({ base: "account_transactions", title: "Sales detail", layout });
    expect(saved.figures).toMatchObject({ base: "account_transactions", selectedColumns: layout.columns, data: { totalDebit: "0.00", totalCredit: "2600.00" } });
    const standard = await w.as((tx) => accountTransactions(tx, { accountId, from: "2026-04-01", to: "2026-05-31" }));
    expect(saved.figures.data).toMatchObject(standard);
    const lines = ((saved.figures as TransactionCustomReportFigures).data as AccountTransactions).accounts[0].lines;
    expect(lines.map((line) => line.credit)).toEqual(["1000.00", "1500.00", "100.00"]);
    // Sales post one ledger line per account and tracking (TC3), so an invoice line's own field isn't on it.
    expect(lines.find((line) => line.source.type === "invoice")!.columnValues).toEqual({
      "contact.email": "accounts@kobe.example.nz",
      "contact.address": "1 Kauri Road, Dunedin",
      "contact.group": "Trade",
      [`contact.custom.${w.region.id}`]: "Otago",
      [`document.custom.${w.channel.id}`]: "Web",
      [`line.custom.${w.project.id}`]: "",
      [`tracking.${w.location.id}`]: "Dunedin",
    });
    // Manual journals have no contact or document fields.
    expect(lines[0].columnValues).toMatchObject({ "contact.email": "", [`contact.custom.${w.region.id}`]: "", [`tracking.${w.location.id}`]: "" });
    expect(await w.journalCount()).toBe(journalsBefore);
  });

  it("CR12: aged receivables offers contact and document columns, not line ones", async () => {
    const w = await transactionSetup();
    const layout = {
      title: "Receivables by region",
      filters: { asAt: "2026-05-31" },
      columns: [`contact.custom.${w.region.id}`, "contact.name", `document.custom.${w.channel.id}`, "current", "total"],
    };
    const saved = await w.saveLayout("aged_receivables", layout);
    const data = (saved.figures as TransactionCustomReportFigures).data as {
      rows: Array<{ name: string; amounts: { current: string }; columnValues: Record<string, string>; invoices: Array<{ columnValues: Record<string, string> }> }>;
      total: { total: string };
    };
    expect(data.total.total).toBe("115.00");
    expect(data.rows.map((row) => [row.name, row.amounts.current])).toEqual([["Kobe Ltd", "115.00"]]);
    expect(data.rows[0].columnValues).toMatchObject({ [`contact.custom.${w.region.id}`]: "Otago", "contact.name": "Kobe Ltd" });
    expect(data.rows[0].invoices[0].columnValues).toMatchObject({ [`document.custom.${w.channel.id}`]: "Web" });
    await w.refused("aged_receivables", layout, [`line.custom.${w.project.id}`, `tracking.${w.location.id}`]);
  });

  it("CR13: sales by salesperson with contact and document columns keeps its figures", async () => {
    const w = await transactionSetup();
    const layout = {
      title: "Sales by rep and region",
      filters: { from: "2026-05-01", to: "2026-05-31" },
      columns: ["salesperson", "invoices", "sales", "creditNotes", "netSales", "document.reference", `contact.custom.${w.region.id}`, `document.custom.${w.channel.id}`],
    };
    const saved = await w.saveLayout("sales_by_salesperson", layout);
    const data = (saved.figures as TransactionCustomReportFigures).data as SalesBySalesperson & {
      rows: Array<SalesBySalesperson["rows"][number] & { documents: Array<{ columnValues: Record<string, string> }> }>;
    };
    expect(data.rows.map((row) => [row.name, row.invoices, row.sales, row.creditNotes, row.netSales])).toEqual([["Aroha", 1, "100.00", "0.00", "100.00"]]);
    expect(data.total).toMatchObject({ invoices: 1, sales: "100.00", creditNotes: "0.00", netSales: "100.00" });
    expect(data.rows[0].documents[0].columnValues).toMatchObject({ [`contact.custom.${w.region.id}`]: "Otago", [`document.custom.${w.channel.id}`]: "Web" });
    await w.refused("sales_by_salesperson", layout, [`line.custom.${w.project.id}`, `tracking.${w.location.id}`]);
  });

  it("CR14: the journal report with a journal line's own field and tracking", async () => {
    const w = await transactionSetup();
    await w.as((tx) =>
      postJournal(tx, {
        idempotencyKey: key("journal"),
        postingDate: "2026-05-25",
        reference: "Fit-out costs",
        lines: [
          { accountCode: "6010", debitAmount: "50.00", creditAmount: "0", customFields: { [w.project.id]: "Fit-out" }, tracking: { [w.location.id]: w.dunedin.id } },
          { accountCode: "1000", debitAmount: "0", creditAmount: "50.00" },
        ],
      }),
    );
    const layout = {
      title: "Journals with projects",
      filters: { from: "2026-05-25", to: "2026-05-25" },
      columns: ["date", "account", "debit", "credit", `line.custom.${w.project.id}`, `tracking.${w.location.id}`],
    };
    const saved = await w.saveLayout("journal_report", layout);
    const data = (saved.figures as TransactionCustomReportFigures).data as JournalReport;
    expect(data.journals).toHaveLength(1);
    const lines = data.journals[0].lines as Array<JournalReport["journals"][number]["lines"][number] & { columnValues: Record<string, string> }>;
    expect(lines.map((line) => [line.debit, line.credit, line.columnValues[`line.custom.${w.project.id}`], line.columnValues[`tracking.${w.location.id}`]])).toEqual([
      ["50.00", "0.00", "Fit-out", "Dunedin"],
      ["0.00", "50.00", "", ""],
    ]);
    expect(saved.figures.data).toMatchObject(await w.as((tx) => journalReport(tx, { from: "2026-05-25", to: "2026-05-25" })));
  });

  it("CR15: viewers open it; drafts show contacts as they are now, published reports stay as published", async () => {
    const w = await transactionSetup();
    const layout = { title: "Receivables", filters: { asAt: "2026-05-31" }, columns: ["contact.name", "contact.email", "total"] };
    const journalsBefore = await w.journalCount();
    const { report } = await w.saveLayout("aged_receivables", layout);
    const { report: published } = await w.as((tx) => publishCustomReport(tx, report.id, { idempotencyKey: key("publish") }));
    expect(await w.journalCount()).toBe(journalsBefore);
    await w.as((tx) => updateContact(tx, w.kobe.id, { email: "ap@kobe.example.nz" }));

    const viewerCookie = await sessionCookieFor(viewer);
    const open = async (id: string) => {
      const response = await reportRoute.GET(apiRequest(`/api/custom-reports/${id}?organisationId=${w.org}`, { cookie: viewerCookie }), {
        params: Promise.resolve({ reportId: id }),
      });
      expect(response.status).toBe(200);
      const { figures } = (await response.json()) as { figures: TransactionCustomReportFigures };
      const data = figures.data as { rows: Array<{ columnValues: Record<string, string> }>; total: { total: string } };
      return [data.rows[0].columnValues["contact.email"], data.total.total];
    };
    expect(await open(report.id)).toEqual(["ap@kobe.example.nz", "115.00"]);
    expect(await open(published.id)).toEqual(["accounts@kobe.example.nz", "115.00"]);
  });
});
