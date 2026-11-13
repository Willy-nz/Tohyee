import { afterAll, beforeAll, expect, it } from "vitest";
import { type ReportTable, reportTableProblems } from "@/lib/ai/report-table";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import {
  computeCustomReport,
  createCustomReport,
  type CustomReport,
  deleteCustomReport,
  getCustomReport,
  previewCustomReport,
  publishCustomReport,
  setCustomReportArchived,
  updateCustomReport,
} from "@/lib/reports/custom";
import { type ComputedBlock, type CustomReportFigures, type CustomReportLayout, groupAccounts, moveAccounts, type ReportRow } from "@/lib/reports/custom-layout";
import { profitAndLoss } from "@/lib/reports/financial";
import { listFavourites, listLayoutDefaults, runDefaultLayout, setFavourite, setLayoutDefault } from "@/lib/reports/report-layouts";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** Examples CR16-CR20 in docs/ACCOUNTING-EXAMPLES.md: editing a report's layout like Xero. */
describeWithDatabase("report layouts", () => {
  let server: TestServer;
  let owner: SessionUser;
  let other: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("layout-owner@example.com", { serverAdmin: true });
    other = await createTestUser("layout-other@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(withVehicle = false) {
    organisations += 1;
    const org = `report-layouts-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, other.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>, user: SessionUser = owner) => inOrganisation(org, { userId: user.id, email: user.email }, work);
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
    if (withVehicle) await journal("2026-06-25", "6120", "1000", "80.00");
    const start = async () =>
      (await as((tx) => createCustomReport(tx, { idempotencyKey: key("create"), base: "profit_and_loss", periodEnd: "2026-06-30", start: "standard" }))).report as CustomReport & {
        layout: CustomReportLayout;
      };
    const save = async (report: CustomReport, change: (layout: CustomReportLayout) => CustomReportLayout | void) => {
      const current = (await as((tx) => getCustomReport(tx, report.id))).report;
      const layout = structuredClone(current.layout) as CustomReportLayout;
      const next = change(layout) ?? layout;
      return as((tx) => updateCustomReport(tx, report.id, { layout: next, version: current.version }));
    };
    return { org, as, start, save };
  }

  const table = (figures: CustomReportFigures) => figures.blocks.find((block) => block.kind === "table") as Extract<ComputedBlock, { kind: "table" }>;
  const rowsOf = (figures: CustomReportFigures) =>
    Object.fromEntries(table(figures).rows.map((row) => [row.label, figures.columns.map((column) => row.values[column.key])]));
  const rowsOfTable = (layout: CustomReportLayout) => (layout.blocks[0] as Extract<CustomReportLayout["blocks"][number], { kind: "table" }>).rows;

  it("CR16: grouping accounts keeps every total", async () => {
    const w = await setup(true);
    const report = await w.start();
    expect(rowsOfTable(report.layout).map((row) => row.label)).toEqual(["Trading income", "Cost of sales", "Gross profit", "Other income", "Operating expenses", "Net profit"]);
    const saved = await w.save(report, (layout) => groupAccounts(layout, "main", "expenses", ["6120"], "Vehicle costs").layout);
    const figures = saved.figures as CustomReportFigures;
    const rows = rowsOf(figures);
    expect(rows["Operating expenses"]).toEqual(["250.00"]);
    expect(rows["Vehicle costs"]).toEqual(["80.00"]);
    expect(rows["Net profit"]).toEqual(["590.00"]);
    expect(figures.inSeveralGroups).toEqual([]);
    expect(figures.notInReport).toEqual([]);
    const standard = await w.as((tx) => profitAndLoss(tx, { from: "2026-06-01", to: "2026-06-30" }));
    expect(standard.netProfit).toBe("590.00");
  });

  it("CR21: moving an account to another group moves its amount and keeps net profit", async () => {
    const w = await setup(true);
    const report = await w.start();
    const moved = await w.save(report, (layout) => moveAccounts(layout, "main", "expenses", ["6120"], "cost_of_sales"));
    const figures = moved.figures as CustomReportFigures;
    const rows = rowsOf(figures);
    expect(rows["Cost of sales"]).toEqual(["380.00"]);
    expect(rows["Gross profit"]).toEqual(["820.00"]);
    expect(rows["Operating expenses"]).toEqual(["250.00"]);
    expect(rows["Net profit"]).toEqual(["590.00"]);
    expect(table(figures).rows.find((row) => row.label === "Cost of sales")!.lines.map((line) => line.code)).toEqual(["5000", "6120"]);
    expect(figures.inSeveralGroups).toEqual([]);
    expect(figures.notInReport).toEqual([]);
    // Cost of sales still takes its own type, and 6120 as well.
    expect(rowsOfTable(moved.report.layout as CustomReportLayout).find((row) => row.id === "cost_of_sales")).toMatchObject({ accountTypes: ["direct_costs"], alsoCodes: ["6120"] });

    // Moving it back puts every figure back.
    const back = await w.save(report, (layout) => moveAccounts(layout, "main", "cost_of_sales", ["6120"], "expenses"));
    const again = rowsOf(back.figures as CustomReportFigures);
    expect(again["Cost of sales"]).toEqual(["300.00"]);
    expect(again["Gross profit"]).toEqual(["900.00"]);
    expect(again["Operating expenses"]).toEqual(["330.00"]);
    expect(again["Net profit"]).toEqual(["590.00"]);

    // A group can't both leave an account out and take it; and the account must exist.
    await expect(
      w.save(report, (layout) => {
        const row = rowsOfTable(layout).find((entry) => entry.id === "expenses") as Extract<ReportRow, { kind: "group" }>;
        row.exceptCodes = ["6120"];
        row.alsoCodes = ["6120"];
      }),
    ).rejects.toThrow("It can only do one");
    await expect(
      w.save(report, (layout) => {
        (rowsOfTable(layout).find((entry) => entry.id === "cost_of_sales") as Extract<ReportRow, { kind: "group" }>).alsoCodes = ["9999"];
      }),
    ).rejects.toThrow("There's no account 9999");
  });

  it("CR17: × ÷ and % of, with blanks for dividing by zero and decimal rounding", async () => {
    const w = await setup();
    const report = await w.start();
    const formula = (id: string, label: string, operation: "multiply" | "divide" | "percent", a: string, b: string | null, by?: string): ReportRow => ({
      id,
      kind: "formula",
      label,
      terms: [],
      operation,
      a,
      ...(b ? { b } : {}),
      ...(by ? { by } : {}),
    });
    const saved = await w.save(report, (layout) => {
      layout.columns = { ...layout.columns, periodCount: 3, difference: true, percent: true };
      rowsOfTable(layout).push(
        formula("gm", "Gross margin %", "percent", "gross_profit", "revenue"),
        formula("nm", "Net margin %", "percent", "net_profit", "revenue"),
        formula("gst", "Expenses incl. GST", "multiply", "expenses", null, "1.15"),
        formula("cps", "Cost per dollar of sales", "divide", "cost_of_sales", "revenue"),
        formula("oi160", "Other income ÷ 160", "divide", "other_income", null, "160"),
        formula("cosoi", "Cost of sales % of other income", "percent", "cost_of_sales", "other_income"),
      );
    });
    const figures = saved.figures as CustomReportFigures;
    expect(figures.columns.map((column) => column.label)).toEqual(["Jun 2026", "May 2026", "Apr 2026", "Difference", "%"]);
    const rows = rowsOf(figures);
    expect(rows["Gross margin %"]).toEqual(["75.0", "73.3", "100.0", "1.7", null]);
    expect(rows["Net margin %"]).toEqual(["55.8", "73.3", "90.0", "-17.5", null]);
    expect(rows["Expenses incl. GST"]).toEqual(["287.50", "0.00", "115.00", "287.50", null]);
    expect(rows["Cost per dollar of sales"]).toEqual(["0.25", "0.27", "0.00", "-0.02", "-6.3"]);
    expect(rows["Other income ÷ 160"].slice(0, 1)).toEqual(["0.13"]);
    expect(rows["Cost of sales % of other income"].slice(0, 3)).toEqual(["1500.0", null, null]);
    expect(table(figures).rows.find((row) => row.id === "gm")!.format).toBe("percent");
    expect(table(figures).rows.find((row) => row.id === "cps")!.format).toBe("number");
    // A sum can't use a %, and nothing can take a % of a %.
    await expect(
      w.save(report, (layout) => {
        rowsOfTable(layout).push(formula("gm2", "Gross margin %", "percent", "gross_profit", "revenue"), {
          id: "bad",
          kind: "formula",
          label: "Margin plus profit",
          terms: [
            { rowId: "gm2", sign: 1 },
            { rowId: "net_profit", sign: 1 },
          ],
        });
      }),
    ).rejects.toThrow("it's a %");
  });

  it("CR18: one default layout per report, named versions, frozen copies refused", async () => {
    const w = await setup();
    const report = await w.start();
    expect(await w.as((tx) => runDefaultLayout(tx, { base: "profit_and_loss", from: "2026-06-01", to: "2026-06-30" }))).toBeNull();
    await w.as((tx) => setLayoutDefault(tx, { base: "profit_and_loss", reportId: report.id }));
    let shown = await w.as((tx) => runDefaultLayout(tx, { base: "profit_and_loss", from: "2026-06-01", to: "2026-06-30" }));
    expect(rowsOf(shown!.figures)["Net profit"]).toEqual(["670.00"]);
    await w.save(report, (layout) => {
      rowsOfTable(layout)[0].label = "Sales";
    });
    shown = await w.as((tx) => runDefaultLayout(tx, { base: "profit_and_loss", from: "2026-06-01", to: "2026-06-30", compare: "1" }));
    // Oldest first by default (decision 1366), as the standard layout.
    expect(shown!.figures.columns.map((column) => column.label)).toEqual(["May 2026", "Jun 2026"]);
    expect(rowsOf(shown!.figures)["Sales"]).toEqual(["1500.00", "1200.00"]);
    expect(rowsOf(shown!.figures)["Net profit"]).toEqual(["1100.00", "670.00"]);
    shown = await w.as((tx) => runDefaultLayout(tx, { base: "profit_and_loss", from: "2026-06-01", to: "2026-06-30", compare: "1", order: "newest_first" }));
    expect(shown!.figures.columns.map((column) => column.label)).toEqual(["Jun 2026", "May 2026"]);
    expect(rowsOf(shown!.figures)["Net profit"]).toEqual(["670.00", "1100.00"]);

    // Save as: a second named draft; setting it replaces the first as the default.
    const copy = (await w.as((tx) => createCustomReport(tx, { idempotencyKey: key("copy"), base: "profit_and_loss", layout: { ...report.layout, title: "Board version" } }))).report;
    expect(copy.title).toBe("Board version");
    const defaults = await w.as((tx) => setLayoutDefault(tx, { base: "profit_and_loss", reportId: copy.id }));
    expect(defaults.map((entry) => [entry.base, entry.reportId])).toEqual([["profit_and_loss", copy.id]]);

    const published = (await w.as((tx) => publishCustomReport(tx, copy.id, { idempotencyKey: key("publish") }))).report;
    await expect(w.as((tx) => setLayoutDefault(tx, { base: "profit_and_loss", reportId: published.id }))).rejects.toThrow("frozen copy");
    await expect(w.as((tx) => setLayoutDefault(tx, { base: "balance_sheet", reportId: copy.id }))).rejects.toThrow("different standard report");

    await w.as((tx) => setCustomReportArchived(tx, copy.id, true));
    expect(await w.as((tx) => listLayoutDefaults(tx))).toEqual([]);
    await w.as((tx) => setLayoutDefault(tx, { base: "profit_and_loss", reportId: report.id }));
    await w.as((tx) => deleteCustomReport(tx, report.id));
    expect(await w.as((tx) => listLayoutDefaults(tx))).toEqual([]);
  });

  it("CR19: hidden rows still count; notes and page breaks change no figure; preview saves nothing", async () => {
    const w = await setup();
    const report = await w.start();
    const layout = structuredClone(report.layout);
    const rows = rowsOfTable(layout);
    rows[2] = { ...rows[2], hidden: true, note: "Before overheads.", pageBreakAfter: true };
    const preview = (await w.as((tx) => previewCustomReport(tx, report.id, layout))) as CustomReportFigures;
    const gross = table(preview).rows.find((row) => row.id === "gross_profit")!;
    expect(gross).toMatchObject({ hidden: true, note: "Before overheads.", pageBreakAfter: true, values: { p0: "900.00" } });
    expect(rowsOf(preview)["Net profit"]).toEqual(["670.00"]);
    const stored = (await w.as((tx) => getCustomReport(tx, report.id))).report;
    expect(stored.version).toBe(report.version);
    const again = await w.as((tx) => computeCustomReport(tx, "profit_and_loss", stored.layout as CustomReportLayout));
    expect(table(again).rows.find((row) => row.id === "gross_profit")!.hidden).toBeUndefined();
  });

  it("CR20: favourites are each person's own", async () => {
    const w = await setup();
    const report = await w.start();
    await w.as((tx) => setFavourite(tx, { key: "std:pnl", favourite: true }));
    expect(await w.as((tx) => setFavourite(tx, { key: `custom:${report.id}`, favourite: true }))).toEqual(["std:pnl", `custom:${report.id}`]);
    expect(await w.as((tx) => listFavourites(tx), other)).toEqual([]);
    expect(await w.as((tx) => setFavourite(tx, { key: "std:pnl", favourite: false }))).toEqual([`custom:${report.id}`]);
    await expect(w.as((tx) => setFavourite(tx, { key: "drop table", favourite: true }))).rejects.toThrow("isn't a report");
  });

  it("the AI lists and runs custom reports, and starts drafts only (decision 1363)", async () => {
    const w = await setup();
    const { findAiTool } = await import("@/lib/ai/catalogue");
    const context = { role: "owner" as const, organisationId: w.org, source: "ai-test", accessLevel: "draft" as const, grantedAccessLevel: "draft" as const };
    const create = findAiTool("create_custom_report_draft")!;
    expect(create.level).toBe("draft");
    const made = (await w.as((tx) => create.run(tx, { base: "profit_and_loss", title: "AI board pack", periodEnd: "2026-06-30", idempotencyKey: "ai-board-pack-1" }, context))) as {
      created: boolean;
      reportId: string;
      kind: string;
    };
    expect(made).toMatchObject({ created: true, kind: "draft" });
    const again = (await w.as((tx) => create.run(tx, { base: "profit_and_loss", title: "AI board pack", periodEnd: "2026-06-30", idempotencyKey: "ai-board-pack-1" }, context))) as { created: boolean; reportId: string };
    expect(again).toMatchObject({ created: false, reportId: made.reportId });
    const list = (await w.as((tx) => findAiTool("list_custom_reports")!.run(tx, {}, context))) as { reports: Array<{ reportId: string; title: string; defaultLayoutFor: string | null }> };
    expect(list.reports).toEqual([expect.objectContaining({ reportId: made.reportId, title: "AI board pack", defaultLayoutFor: null })]);
    // The same columns and rows shape as profit_and_loss (#575).
    const run = (await w.as((tx) => findAiTool("run_custom_report")!.run(tx, { reportId: made.reportId }, context))) as ReportTable;
    expect(reportTableProblems(run)).toEqual([]);
    const byLabel = Object.fromEntries(run.rows.map((row) => [row.label, run.columns.map((column) => row.values[column.key])]));
    expect(byLabel["Trading income"]).toEqual(["1200.00"]);
    expect(byLabel["Net profit"]).toEqual(["670.00"]);
    expect(run).toMatchObject({ report: "custom_report", reportId: made.reportId, layout: expect.objectContaining({ title: "AI board pack" }) });
    // It made no default layout and published nothing.
    expect(await w.as((tx) => listLayoutDefaults(tx))).toEqual([]);
  });
});
